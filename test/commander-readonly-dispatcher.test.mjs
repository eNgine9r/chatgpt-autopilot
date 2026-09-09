import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { protocolEnvelope, validateOperationResult } from '../src/commander/contracts/index.mjs';
import { CommanderReadOnlyPolicy } from '../src/commander/agent/read-policy.mjs';
import { CommanderReadOnlyDispatcher } from '../src/commander/agent/readonly-dispatcher.mjs';
import { gitDiffData, gitLogData, gitStatusData } from '../src/commander/agent/read-system.mjs';

const execFileAsync = promisify(execFile);
const silentLogger = { info() {}, warn() {}, error() {} };

function request(operation, params, extra = {}) {
  return {
    ...protocolEnvelope(), requestId: `req-${operation.replaceAll('.', '-')}-${Math.random().toString(16).slice(2)}`,
    deviceId: 'readonly-device', operation, params, ...extra,
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-readonly-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await fs.writeFile(path.join(repo, 'hello.txt'), 'hello Commander\nsecond line\n');
  await fs.writeFile(path.join(repo, '.env'), 'SECRET=hidden\n');
  await execFileAsync('git', ['init'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'Commander Test'], { cwd: repo });
  await execFileAsync('git', ['add', 'hello.txt'], { cwd: repo });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
  await fs.appendFile(path.join(repo, 'hello.txt'), 'changed\n');
  const policy = await CommanderReadOnlyPolicy.create({
    version: 1, roots: [root], repositories: [repo], services: ['demo.service'],
  });
  return { root, repo, policy };
}

test('typed read dispatcher handles files, health, processes and Git without write authority', async (t) => {
  const { repo, policy } = await fixture(t);
  const dispatcher = new CommanderReadOnlyDispatcher({ deviceId: 'readonly-device', policy, logger: silentLogger });

  const health = validateOperationResult(await dispatcher.handle(request('device.health', {})));
  assert.equal(health.ok, true);
  assert.equal(health.data.platform, 'linux');

  const read = validateOperationResult(await dispatcher.handle(request('file.read', { path: path.join(repo, 'hello.txt') })));
  assert.equal(read.ok, true);
  assert.match(read.data.content, /hello Commander/);

  const list = await dispatcher.handle(request('file.list', { path: repo }));
  assert.equal(list.ok, true);
  assert.ok(list.data.entries.some((item) => item.name === 'hello.txt'));
  assert.ok(!list.data.entries.some((item) => item.name === '.env'));
  assert.ok(!list.data.entries.some((item) => item.name === '.git'));

  const info = await dispatcher.handle(request('file.info', { path: path.join(repo, 'hello.txt') }));
  assert.equal(info.ok, true);
  assert.equal(info.data.type, 'file');

  const search = await dispatcher.handle(request('file.search', { path: repo, query: 'Commander', mode: 'content' }));
  assert.equal(search.ok, true);
  assert.equal(search.data.results.length, 1);

  const processes = await dispatcher.handle(request('process.list', { limit: 8 }));
  assert.equal(processes.ok, true);
  assert.ok(Array.isArray(processes.data.processes));
  assert.ok(processes.data.processes.every((item) => !Object.hasOwn(item, 'cmdline')));

  const status = await dispatcher.handle(request('git.status', { repo }));
  assert.equal(status.ok, true);
  assert.ok(status.data.changes.some((line) => line.includes('hello.txt')));

  const diff = await dispatcher.handle(request('git.diff', { repo }));
  assert.equal(diff.ok, true);
  assert.match(diff.data.diff, /changed/);

  const log = await dispatcher.handle(request('git.log', { repo, limit: 5 }));
  assert.equal(log.ok, true);
  assert.equal(log.data.commits[0].subject, 'initial');
});

test('read dispatcher fails closed for secret paths, writes and expired requests', async (t) => {
  const { repo, policy } = await fixture(t);
  const now = Date.parse('2026-09-09T10:00:00.000Z');
  const dispatcher = new CommanderReadOnlyDispatcher({ deviceId: 'readonly-device', policy, now: () => now, logger: silentLogger });

  const secret = await dispatcher.handle(request('file.read', { path: path.join(repo, '.env') }));
  assert.equal(secret.ok, false);
  assert.equal(secret.error.category, 'policy');
  assert.equal(secret.error.code, 'READ_POLICY_SECRET_PATH_DENIED');

  const gitInternal = await dispatcher.handle(request('file.read', { path: path.join(repo, '.git', 'config') }));
  assert.equal(gitInternal.ok, false);
  assert.equal(gitInternal.error.code, 'READ_POLICY_SECRET_PATH_DENIED');

  const traversal = await dispatcher.handle(request('git.diff', { repo, paths: ['../../etc/passwd'] }));
  assert.equal(traversal.ok, false);
  assert.equal(traversal.error.category, 'validation');

  const write = await dispatcher.handle(request('file.write', { path: path.join(repo, 'x') }, { idempotencyKey: 'idem-write-1' }));
  assert.equal(write.ok, false);
  assert.equal(write.error.category, 'authorization');

  const expired = await dispatcher.handle(request('device.health', {}, { deadlineAt: '2026-09-09T09:59:00.000Z' }));
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, 'READ_REQUEST_DEADLINE_EXPIRED');
});

test('service status uses fixed structured runner and only approved service names', async (t) => {
  const { policy } = await fixture(t);
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    return { exitCode: 0, timedOut: false, stdout: 'Id=demo.service\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=123\n', stderr: '', truncated: false, totalBytes: 120 };
  };
  const dispatcher = new CommanderReadOnlyDispatcher({ deviceId: 'readonly-device', policy, commandRunner: runner, logger: silentLogger });
  const result = await dispatcher.handle(request('service.status', { service: 'demo.service' }));
  assert.equal(result.ok, true);
  assert.equal(result.data.activeState, 'active');
  assert.deepEqual(calls[0].command, 'systemctl');
  assert.deepEqual(calls[0].args.slice(0, 3), ['--user', 'show', 'demo.service']);

  const denied = await dispatcher.handle(request('service.status', { service: 'ssh.service' }));
  assert.equal(denied.ok, false);
  assert.equal(denied.error.category, 'policy');
});


test('Git read handlers disable hooks, fsmonitor and external/textconv diff behavior', async (t) => {
  const { repo, policy } = await fixture(t);
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    const isLog = args.includes('log');
    return { exitCode: 0, timedOut: false, stdout: isLog ? `${'a'.repeat(40)}\t2026-09-09T10:00:00Z\tsubject` : '', stderr: '', truncated: false, totalBytes: 0 };
  };
  await gitStatusData(policy, { repo }, runner);
  await gitDiffData(policy, { repo }, runner);
  await gitLogData(policy, { repo }, runner);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.command, 'git');
    assert.deepEqual(call.args.slice(0, 4), ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']);
  }
  const diffCall = calls.find((call) => call.args.includes('diff'));
  assert.ok(diffCall.args.includes('--no-ext-diff'));
  assert.ok(diffCall.args.includes('--no-textconv'));
});
