import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommanderAgentClient } from '../src/commander/agent/client.mjs';
import { CommanderAgentOperationDispatcher } from '../src/commander/agent/operation-dispatcher.mjs';
import { CommanderControlledWriteDispatcher } from '../src/commander/agent/controlled-write-dispatcher.mjs';
import { CommanderWritePolicy, phase5WriteCapabilities } from '../src/commander/agent/write-policy.mjs';
import { CommanderGatewayServer } from '../src/commander/gateway/server.mjs';
import { protocolEnvelope } from '../src/commander/contracts/index.mjs';
import { runAgentService } from '../src/commander/agent/service.mjs';
import { runGatewayService } from '../src/commander/gateway/service.mjs';

const secret='phase-five-session-secret-material-123456789';
const identity={version:1,deviceId:'phase5-session-device',createdAt:new Date().toISOString()};
const logger={info(){},warn(){},error(){}};
function request(id,operation,params,key){return{...protocolEnvelope(),requestId:id,deviceId:identity.deviceId,operation,params,idempotencyKey:key};}
function waitState(agent,wanted,timeoutMs=3000){if(agent.state===wanted)return Promise.resolve();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`state_timeout:${wanted}:${agent.state}`)),timeoutMs);const listener=(state)=>{if(state===wanted){clearTimeout(timer);agent.off('state',listener);resolve();}};agent.on('state',listener);});}

async function setup(t,{gatewayWrite=true,rootDecision='allow'}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'commander-write-session-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const policy=await CommanderWritePolicy.create({version:1,roots:[{path:root,decision:rootDecision,maxFileBytes:65536}],services:[],repositories:[]});
  const writeDispatcher=new CommanderControlledWriteDispatcher({deviceId:identity.deviceId,policy,logger});
  const dispatcher=new CommanderAgentOperationDispatcher({readDispatcher:{handle(){throw new Error('unused');}},writeDispatcher});
  let gateway=new CommanderGatewayServer({host:'127.0.0.1',port:0,secretResolver:async()=>secret,logger,heartbeatIntervalMs:250,heartbeatTimeoutMs:1200,allowedAuthorities:gatewayWrite?['read','write']:['read']});
  const address=await gateway.start();
  const agent=new CommanderAgentClient({gatewayHost:'127.0.0.1',gatewayPort:address.port,identity,secret,logger,capabilities:phase5WriteCapabilities(),operationHandler:(r)=>dispatcher.handle(r),allowedAuthorities:['read','write'],reconnectBaseMs:100,reconnectMaxMs:200,reconnectJitterRatio:0});
  agent.start();await waitState(agent,'online');t.after(async()=>{await agent.stop();await gateway.stop();});
  return{root,agent,writeDispatcher,get gateway(){return gateway;},replaceGateway(next){gateway=next;},port:address.port};
}

test('authenticated Gateway routes only explicitly advertised controlled writes',async(t)=>{
  const ctx=await setup(t);const file=path.join(ctx.root,'session.txt');
  const result=await ctx.gateway.request(request('w1','file.write',{path:file,content:'session',mode:'create'},'session-write'));
  assert.equal(result.ok,true);assert.equal(await fs.readFile(file,'utf8'),'session');assert.equal(result.data.evidence.mutated,true);
});

test('Gateway default authority blocks controlled writes even when Agent advertises them',async(t)=>{
  const ctx=await setup(t,{gatewayWrite:false});const file=path.join(ctx.root,'blocked.txt');
  assert.throws(()=>ctx.gateway.request(request('w2','file.write',{path:file,content:'blocked',mode:'create'},'blocked-key')),/gateway_read_only/);
  await assert.rejects(()=>fs.stat(file),/ENOENT/);
});

test('approval policy survives transport and does not mutate without verifier',async(t)=>{
  const ctx=await setup(t,{rootDecision:'approval'});const file=path.join(ctx.root,'approval.txt');
  const result=await ctx.gateway.request(request('w3','file.write',{path:file,content:'pending',mode:'create'},'approval-key'));
  assert.equal(result.ok,false);assert.equal(result.error.code,'REQUIRES_APPROVAL');assert.equal(result.data.decision,'requires_approval');await assert.rejects(()=>fs.stat(file),/ENOENT/);
});

test('reconnect replay preserves idempotency and does not repeat mutation',async(t)=>{
  const ctx=await setup(t);const file=path.join(ctx.root,'once.txt');const params={path:file,content:'once',mode:'create'};
  const first=await ctx.gateway.request(request('first','file.write',params,'same-key'));assert.equal(first.ok,true);
  const disconnected=waitState(ctx.agent,'disconnected');await ctx.gateway.stop();await disconnected;
  const replacement=new CommanderGatewayServer({host:'127.0.0.1',port:ctx.port,secretResolver:async()=>secret,logger,heartbeatIntervalMs:250,heartbeatTimeoutMs:1200,allowedAuthorities:['read','write']});ctx.replaceGateway(replacement);await replacement.start();await waitState(ctx.agent,'online',5000);
  const replay=await replacement.request(request('second','file.write',params,'same-key'));assert.equal(replay.ok,true);assert.equal(replay.requestId,'second');assert.equal(await fs.readFile(file,'utf8'),'once');
});

test('conflicting idempotency reuse stays structured across authenticated transport',async(t)=>{
  const ctx=await setup(t);const file=path.join(ctx.root,'conflict.txt');const key='transport-conflict';
  const first=await ctx.gateway.request(request('c1','file.write',{path:file,content:'one',mode:'create'},key));assert.equal(first.ok,true);
  const conflict=await ctx.gateway.request(request('c2','file.write',{path:file,content:'different',mode:'upsert'},key));
  assert.equal(conflict.ok,false);assert.equal(conflict.error.code,'IDEMPOTENCY_KEY_CONFLICT');assert.equal(conflict.error.category,'conflict');
  assert.equal(await fs.readFile(file,'utf8'),'one');
});

test('Phase 5 service entrypoints reject ADMIN enablement before loading credentials',async()=>{
  await assert.rejects(()=>runAgentService({COMMANDER_ENABLED:'true',COMMANDER_ADMIN_ENABLED:'true'}),/commander_admin_not_supported_phase5/);
  await assert.rejects(()=>runGatewayService({COMMANDER_ENABLED:'true',COMMANDER_ADMIN_ENABLED:'true'}),/commander_admin_not_supported_phase5/);
});
