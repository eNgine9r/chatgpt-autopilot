import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommanderWritePolicy, phase5WriteCapabilities } from '../src/commander/agent/write-policy.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-write-policy-'));
  const approval = path.join(root, 'approval');
  const denied = path.join(root, 'denied');
  const repo = path.join(root, 'repo');
  await Promise.all([fs.mkdir(approval), fs.mkdir(denied), fs.mkdir(repo)]);
  const remoteUrl = path.join(root, 'remote.git');
  const policy = await CommanderWritePolicy.create({ version: 1,
    roots: [
      { path: root, decision: 'allow', maxFileBytes: 65536 },
      { path: approval, decision: 'approval', maxFileBytes: 4096 },
      { path: denied, decision: 'deny', maxFileBytes: 4096 },
    ],
    services: [{ unit: 'demo.service', start: 'deny', stop: 'approval', restart: 'allow' }],
    repositories: [{ alias: 'demo', path: repo, commit: 'allow', push: 'approval', remote: 'origin', remoteUrl,
      allowedBranches: ['feature/*'], protectedBranches: ['main', 'release/*'] }],
  });
  return { root, approval, denied, repo, remoteUrl, policy };
}

test('write policy resolves only allowlisted regular paths and blocks secrets/symlinks', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const normal = path.join(f.root, 'normal.txt');
  await fs.writeFile(normal, 'ok');
  assert.equal((await f.policy.resolveFile(normal, { mustExist: true })).root.decision, 'allow');
  await assert.rejects(() => f.policy.resolveFile(path.join(f.root, '.env')), /WRITE_POLICY_SECRET_PATH_DENIED/);
  const target = path.join(f.root, 'target.txt'); await fs.writeFile(target, 'safe');
  const link = path.join(f.root, 'link.txt'); await fs.symlink(target, link);
  await assert.rejects(() => f.policy.resolveFile(link), /WRITE_POLICY_SYMLINK_DENIED/);
  await assert.rejects(() => f.policy.resolveFile(path.join(os.tmpdir(), 'outside-commander-write.txt')), /WRITE_POLICY_PATH_OUTSIDE_ROOTS/);
});

test('repository policy combines root decision and blocks protected or unapproved branches', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const repoRule = f.policy.repository('demo', 'commit');
  assert.equal(repoRule.decision, 'allow');
  assert.equal(f.policy.repository('demo', 'push').decision, 'approval');
  assert.equal(f.policy.assertBranch(repoRule.repo, 'feature/safe'), 'feature/safe');
  assert.throws(() => f.policy.assertBranch(repoRule.repo, 'main'), /WRITE_POLICY_PROTECTED_BRANCH/);
  assert.throws(() => f.policy.assertBranch(repoRule.repo, 'random'), /WRITE_POLICY_BRANCH_NOT_ALLOWED/);
  const nestedApprovalRepo = path.join(f.approval, 'repo2'); await fs.mkdir(nestedApprovalRepo);
  const policy = await CommanderWritePolicy.create({ version: 1,
    roots: [{ path: f.root, decision: 'allow', maxFileBytes: 65536 }, { path: f.approval, decision: 'approval', maxFileBytes: 65536 }],
    services: [], repositories: [{ alias: 'approval-repo', path: nestedApprovalRepo, commit: 'allow', push: 'allow', remote: 'origin', remoteUrl: f.remoteUrl, allowedBranches: ['feature/*'], protectedBranches: [] }],
  });
  assert.equal(policy.repository('approval-repo', 'commit').decision, 'approval');
});

test('remote URL and service policy validation fail closed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-write-policy-invalid-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  await assert.rejects(() => CommanderWritePolicy.create({ version: 1, roots: [{ path: root, decision: 'allow', maxFileBytes: 1024 }], services: [], repositories: [{ alias: 'repo', path: repo, commit: 'allow', push: 'allow', remote: 'origin', remoteUrl: 'ext::sh -c evil', allowedBranches: ['*'], protectedBranches: [] }] }), /invalid_write_repository_remote_url/);
  const policy = await CommanderWritePolicy.create({ version: 1, roots: [{ path: root, decision: 'allow', maxFileBytes: 1024 }], services: [{ unit: 'safe.service', start: 'allow', stop: 'deny', restart: 'approval' }], repositories: [] });
  assert.equal(policy.service('safe.service', 'start').decision, 'allow');
  assert.equal(policy.service('safe.service', 'stop').decision, 'deny');
  assert.throws(() => policy.service('other.service', 'restart'), /WRITE_POLICY_SERVICE_NOT_ALLOWED/);
});

test('Phase 5 advertises only controlled WRITE operations and no process/admin authority', () => {
  const capabilities = phase5WriteCapabilities();
  const names = capabilities.map((c) => c.operation);
  assert.deepEqual(names, ['file.write','file.edit','file.move','service.start','service.stop','service.restart','git.commit','git.push']);
  assert.ok(capabilities.every((c) => c.authority === 'write'));
  assert.equal(names.includes('process.terminate'), false);
  assert.equal(names.some((name) => name.startsWith('system.')), false);
});
