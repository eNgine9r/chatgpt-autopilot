import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommanderControlledWriteDispatcher } from '../src/commander/agent/controlled-write-dispatcher.mjs';
import { CommanderWritePolicy } from '../src/commander/agent/write-policy.mjs';
import { protocolEnvelope } from '../src/commander/contracts/index.mjs';

const exec = promisify(execFile); const deviceId='phase5-git-device';
function request(id, operation, params, key) { return { ...protocolEnvelope(), requestId:id, deviceId, operation, params, idempotencyKey:key }; }
async function git(cwd, ...args) { return exec('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null' } }); }
async function setupRepo(t, branch='feature/test') {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'commander-write-git-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo'); const remote=path.join(root,'remote.git'); await fs.mkdir(repo);
  await git(repo,'init',`--initial-branch=${branch}`); await git(repo,'config','user.name','Commander Test'); await git(repo,'config','user.email','commander@example.invalid');
  await fs.writeFile(path.join(repo,'a.txt'),'initial\n'); await git(repo,'add','a.txt'); await git(repo,'commit','-m','initial');
  await exec('git',['init','--bare',remote]); await git(repo,'remote','add','origin',remote);
  const policy=await CommanderWritePolicy.create({version:1,roots:[{path:root,decision:'allow',maxFileBytes:65536}],services:[],repositories:[{alias:'demo',path:repo,commit:'allow',push:'allow',remote:'origin',remoteUrl:remote,allowedBranches:['feature/*'],protectedBranches:['main','release/*']}]});
  return {root,repo,remote,policy,dispatcher:new CommanderControlledWriteDispatcher({deviceId,policy,logger:{info(){}}})};
}

test('Git commit and push mutate only approved branch/repo and return evidence', async (t)=>{
  const f=await setupRepo(t); const before=(await git(f.repo,'rev-parse','HEAD')).stdout.trim();
  await fs.writeFile(path.join(f.repo,'a.txt'),'changed\n');
  const commit=await f.dispatcher.handle(request('c1','git.commit',{repo:'demo',message:'controlled change',paths:['a.txt']},'commit-key'));
  assert.equal(commit.ok,true); assert.equal(commit.data.evidence.beforeHead,before); assert.notEqual(commit.data.evidence.afterHead,before); assert.equal(commit.data.evidence.branch,'feature/test');
  const push=await f.dispatcher.handle(request('p1','git.push',{repo:'demo'},'push-key'));
  assert.equal(push.ok,true); assert.equal(push.data.evidence.remoteUrl,f.remote);
  const remoteHead=(await exec('git',['--git-dir',f.remote,'rev-parse','refs/heads/feature/test'])).stdout.trim();
  assert.equal(remoteHead,commit.data.evidence.afterHead);
});

test('Git commit refuses pre-existing staged changes before mutating index/head', async (t)=>{
  const f=await setupRepo(t); const before=(await git(f.repo,'rev-parse','HEAD')).stdout.trim();
  await fs.writeFile(path.join(f.repo,'b.txt'),'staged\n'); await git(f.repo,'add','b.txt'); await fs.writeFile(path.join(f.repo,'a.txt'),'changed\n');
  const result=await f.dispatcher.handle(request('c2','git.commit',{repo:'demo',message:'must fail',paths:['a.txt']},'staged-key'));
  assert.equal(result.ok,false); assert.equal(result.error.code,'WRITE_GIT_PREEXISTING_STAGED_CHANGES'); assert.equal((await git(f.repo,'rev-parse','HEAD')).stdout.trim(),before);
  assert.match((await git(f.repo,'diff','--cached','--name-only')).stdout,/b\.txt/);
});

test('Git protected branches and remote mismatch fail before push', async (t)=>{
  const protectedRepo=await setupRepo(t,'main'); await fs.writeFile(path.join(protectedRepo.repo,'a.txt'),'changed\n');
  const blocked=await protectedRepo.dispatcher.handle(request('c3','git.commit',{repo:'demo',message:'blocked',paths:['a.txt']},'protected-key'));
  assert.equal(blocked.ok,false); assert.equal(blocked.error.code,'WRITE_POLICY_PROTECTED_BRANCH');
  const f=await setupRepo(t); const other=path.join(f.root,'different.git');
  const mismatchPolicy=await CommanderWritePolicy.create({version:1,roots:[{path:f.root,decision:'allow',maxFileBytes:65536}],services:[],repositories:[{alias:'demo',path:f.repo,commit:'allow',push:'allow',remote:'origin',remoteUrl:other,allowedBranches:['feature/*'],protectedBranches:[]}]});
  const mismatch=new CommanderControlledWriteDispatcher({deviceId,policy:mismatchPolicy,logger:{info(){}}});
  const result=await mismatch.handle(request('p2','git.push',{repo:'demo'},'mismatch-key'));
  assert.equal(result.ok,false); assert.equal(result.error.code,'WRITE_GIT_REMOTE_MISMATCH');
});

test('approved user service action uses fixed systemctl argv and captures before/after evidence', async (t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'commander-write-service-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const policy=await CommanderWritePolicy.create({version:1,roots:[{path:root,decision:'allow',maxFileBytes:1024}],services:[{unit:'demo.service',start:'allow',stop:'deny',restart:'approval'}],repositories:[]});
  let active='inactive'; const calls=[];
  const runner=async (command,args)=>{ calls.push([command,...args]); if(args[1]==='show') return {exitCode:0,timedOut:false,stdout:`LoadState=loaded\nActiveState=${active}\nSubState=${active==='active'?'running':'dead'}\nUnitFileState=enabled\nMainPID=${active==='active'?42:0}\n`,stderr:'',truncated:false,totalBytes:0}; if(args[1]==='start'){active='active';return {exitCode:0,timedOut:false,stdout:'',stderr:'',truncated:false,totalBytes:0};} throw new Error('unexpected'); };
  const dispatcher=new CommanderControlledWriteDispatcher({deviceId,policy,commandRunner:runner,logger:{info(){}}});
  const result=await dispatcher.handle(request('s1','service.start',{unit:'demo.service'},'service-key'));
  assert.equal(result.ok,true); assert.equal(result.data.evidence.before.activeState,'inactive'); assert.equal(result.data.evidence.after.activeState,'active'); assert.deepEqual(calls[1],['systemctl','--user','start','demo.service']);
  const denied=await dispatcher.handle(request('s2','service.stop',{unit:'demo.service'},'service-deny'));
  assert.equal(denied.ok,false); assert.equal(denied.error.code,'WRITE_POLICY_DENIED'); assert.equal(calls.filter((c)=>c.includes('stop')).length,0);
});

test('Git plumbing bypasses repo clean filters and hooks during controlled commit/push', async (t) => {
  const f = await setupRepo(t);
  const filterMarker = path.join(f.root, 'filter-ran');
  const hookMarker = path.join(f.root, 'hook-ran');
  await fs.writeFile(path.join(f.repo, '.gitattributes'), 'a.txt filter=evil\n');
  await git(f.repo, 'add', '.gitattributes');
  await git(f.repo, 'commit', '-m', 'attributes before hostile filter');
  await git(f.repo, 'config', 'filter.evil.clean', `sh -c 'echo filter > ${filterMarker}; cat'`);
  const hook = path.join(f.repo, '.git', 'hooks', 'pre-push');
  await fs.writeFile(hook, `#!/bin/sh\necho hook > '${hookMarker}'\nexit 1\n`, { mode: 0o755 });
  await fs.writeFile(path.join(f.repo, 'a.txt'), 'changed without filter\n');
  const commit = await f.dispatcher.handle(request('safe-c','git.commit',{repo:'demo',message:'safe plumbing',paths:['a.txt']},'safe-commit'));
  assert.equal(commit.ok, true); assert.equal(commit.data.evidence.filtersBypassed, true);
  await assert.rejects(() => fs.stat(filterMarker), /ENOENT/);
  const push = await f.dispatcher.handle(request('safe-p','git.push',{repo:'demo'},'safe-push'));
  assert.equal(push.ok, true);
  await assert.rejects(() => fs.stat(hookMarker), /ENOENT/);
});
