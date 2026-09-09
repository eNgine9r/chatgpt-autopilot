import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommanderReadOnlyPolicy, isDefaultSecretPath, phase3ReadCapabilities } from '../src/commander/agent/read-policy.mjs';

test('Phase 3 capability advertisement is read-only and explicit', () => {
  const capabilities = phase3ReadCapabilities();
  assert.ok(capabilities.length >= 10);
  assert.ok(capabilities.every((item) => item.authority === 'read' && item.operationVersion === 1));
  assert.ok(capabilities.some((item) => item.operation === 'git.log'));
  assert.ok(!capabilities.some((item) => item.operation === 'file.write'));
});

test('read policy blocks traversal, symlink escape and default secret paths', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-ro-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-ro-outside-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await fs.writeFile(path.join(repo, 'safe.txt'), 'safe');
  await fs.writeFile(path.join(repo, '.env'), 'TOP_SECRET=yes');
  await fs.writeFile(path.join(repo, '.env.example'), 'SAFE_SAMPLE=yes');
  await fs.writeFile(path.join(outside, 'outside.txt'), 'nope');
  await fs.symlink(path.join(outside, 'outside.txt'), path.join(repo, 'escape-link'));

  const policy = await CommanderReadOnlyPolicy.create({
    version: 1, roots: [root], repositories: [repo], services: ['chatgpt-autopilot-v3.service'],
  });
  assert.equal(await policy.assertPath(path.join(repo, 'safe.txt')), path.join(repo, 'safe.txt'));
  assert.equal(await policy.assertPath(path.join(repo, '.env.example')), path.join(repo, '.env.example'));
  await assert.rejects(() => policy.assertPath(path.join(repo, '.env')), /READ_POLICY_SECRET_PATH_DENIED/);
  await assert.rejects(() => policy.assertPath(path.join(outside, 'outside.txt')), /READ_POLICY_PATH_OUTSIDE_ROOTS/);
  await assert.rejects(() => policy.assertPath(path.join(repo, 'escape-link')), /READ_POLICY_PATH_OUTSIDE_ROOTS/);
  assert.equal(await policy.assertRepository(repo), repo);
  await assert.rejects(() => policy.assertRepository(root), /READ_POLICY_REPOSITORY_NOT_ALLOWED/);
  assert.equal(policy.assertService('chatgpt-autopilot-v3.service'), 'chatgpt-autopilot-v3.service');
  assert.throws(() => policy.assertService('ssh.service'), /READ_POLICY_SERVICE_NOT_ALLOWED/);
});

test('default secret matcher denies credentials but permits templates', () => {
  assert.equal(isDefaultSecretPath('/tmp/repo/.ssh/id_ed25519'), true);
  assert.equal(isDefaultSecretPath('/tmp/repo/private.pem'), true);
  assert.equal(isDefaultSecretPath('/tmp/repo/.env.production'), true);
  assert.equal(isDefaultSecretPath('/tmp/repo/.env.example'), false);
  assert.equal(isDefaultSecretPath('/tmp/repo/config.json'), false);
});

test('empty policy is a valid fail-closed filesystem/service configuration', async () => {
  const policy = await CommanderReadOnlyPolicy.create({ version: 1, roots: [], repositories: [], services: [] });
  await assert.rejects(() => policy.assertPath('/tmp'), /READ_POLICY_PATH_OUTSIDE_ROOTS/);
  assert.throws(() => policy.assertService('anything.service'), /READ_POLICY_SERVICE_NOT_ALLOWED/);
});
