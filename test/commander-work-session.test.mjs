import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { protocolEnvelope } from '../src/commander/contracts/index.mjs';
import { CommanderReadOnlyPolicy } from '../src/commander/agent/read-policy.mjs';
import { CommanderWorkSessionManager } from '../src/commander/agent/work-session.mjs';

const execFileAsync = promisify(execFile);
const deviceId = 'device-a';

async function git(repo, ...args) {
  return execFileAsync('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-work-session-'));
  const repo = path.join(root, 'repo');
  const stateFile = path.join(root, 'state', 'work-sessions.json');
  await fs.mkdir(repo);
  await git(repo, 'init', '-b', 'feat/test-session');
  await fs.writeFile(path.join(repo, 'README.md'), 'initial\n');
  await git(repo, 'add', 'README.md');
  await git(repo, '-c', 'user.name=Commander Test', '-c', 'user.email=commander@example.invalid', 'commit', '-m', 'initial');
  const policy = await CommanderReadOnlyPolicy.create({ version: 1, roots: [root], repositories: [repo], services: [] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, repo, stateFile, policy };
}

function request(operation, params, extra = {}) {
  return {
    ...protocolEnvelope(), requestId: `req-${Math.random().toString(16).slice(2)}`,
    deviceId, operation, params, ...extra,
  };
}

async function openSession(manager, repo, key = 'idem-open-1') {
  return manager.handle(request('work_session.open', {
    projectId: 'autopilot', workspaceRoot: repo, repositoryPath: repo,
    resumeNote: 'Continue persistent session implementation.',
  }, { idempotencyKey: key }));
}

test('persistent work session survives reconnect/reload with private bounded state', async (t) => {
  const { repo, stateFile, policy } = await fixture(t);
  const manager = new CommanderWorkSessionManager({ deviceId, stateFile, readPolicy: policy });
  await manager.load();
  const opened = await openSession(manager, repo);
  assert.equal(opened.ok, true);
  const sessionId = opened.data.session.sessionId;
  assert.match(sessionId, /^work-/);
  assert.equal(opened.data.session.repository.dirty, false);
  assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(stateFile))).mode & 0o777, 0o700);

  const reloaded = new CommanderWorkSessionManager({ deviceId, stateFile, readPolicy: policy });
  await reloaded.load();
  const listed = await reloaded.handle(request('work_session.list', {}));
  assert.equal(listed.ok, true);
  assert.equal(listed.data.sessions[0].sessionId, sessionId);
  const resumed = await reloaded.handle(request('work_session.resume', { sessionId }));
  assert.equal(resumed.ok, true);
  assert.equal(resumed.data.diverged, false);
  assert.equal(resumed.data.session.projectId, 'autopilot');
  assert.equal(resumed.data.session.resumeNote, 'Continue persistent session implementation.');
  assert.equal(resumed.data.session.repository.head, opened.data.session.repository.head);
});

test('out-of-band repository change blocks the next scoped mutation until explicit checkpoint', async (t) => {
  const { repo, stateFile, policy } = await fixture(t);
  const manager = new CommanderWorkSessionManager({ deviceId, stateFile, readPolicy: policy });
  await manager.load();
  const opened = await openSession(manager, repo);
  const sessionId = opened.data.session.sessionId;

  await fs.writeFile(path.join(repo, 'README.md'), 'changed outside commander\n');
  const resumed = await manager.handle(request('work_session.resume', { sessionId }));
  assert.equal(resumed.data.diverged, true);

  const blocked = await manager.guardMutation(request('file.write', { path: path.join(repo, 'x.txt'), content: 'x', mode: 'create' }, {
    idempotencyKey: 'idem-write-1', workSessionId: sessionId,
  }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'WORK_SESSION_DIVERGED');

  const checkpoint = await manager.handle(request('work_session.checkpoint', { sessionId, resumeNote: 'Accepted current dirty tree as baseline.' }, {
    idempotencyKey: 'idem-checkpoint-1',
  }));
  assert.equal(checkpoint.ok, true);
  assert.equal(checkpoint.data.session.repository.dirty, true);

  const allowed = await manager.guardMutation(request('file.write', { path: path.join(repo, 'x.txt'), content: 'x', mode: 'create' }, {
    idempotencyKey: 'idem-write-2', workSessionId: sessionId,
  }));
  assert.equal(allowed, null);
});

test('active execution is persisted and becomes explicitly interrupted after Agent restart', async (t) => {
  const { repo, stateFile, policy } = await fixture(t);
  const manager = new CommanderWorkSessionManager({ deviceId, stateFile, readPolicy: policy });
  await manager.load();
  const opened = await openSession(manager, repo);
  const sessionId = opened.data.session.sessionId;
  const started = {
    ...protocolEnvelope(), requestId: 'req-exec-start', deviceId, operation: 'execution.start', ok: true,
    completedAt: '2026-09-17T09:30:00Z',
    data: { execution: { executionId: 'exec-1', state: 'running', createdAt: '2026-09-17T09:29:59Z', updatedAt: '2026-09-17T09:30:00Z' } },
  };
  await manager.observeOperation(request('execution.start', { alias: 'tests' }, {
    idempotencyKey: 'idem-exec-1', workSessionId: sessionId,
  }), started);

  const reloaded = new CommanderWorkSessionManager({ deviceId, stateFile, readPolicy: policy });
  await reloaded.load();
  const state = await reloaded.handle(request('work_session.get', { sessionId }));
  assert.equal(state.data.session.executions[0].executionId, 'exec-1');
  assert.equal(state.data.session.executions[0].state, 'interrupted');
  assert.equal(state.data.session.executions[0].interruptedReason, 'agent_restart');
});

test('work-session mutations have persistent idempotency and reject semantic key reuse', async (t) => {
  const { repo, stateFile, policy } = await fixture(t);
  const manager = new CommanderWorkSessionManager({ deviceId, stateFile, readPolicy: policy });
  await manager.load();
  const first = await openSession(manager, repo, 'idem-stable');
  assert.equal(first.ok, true);

  const reloaded = new CommanderWorkSessionManager({ deviceId, stateFile, readPolicy: policy });
  await reloaded.load();
  const replay = await openSession(reloaded, repo, 'idem-stable');
  assert.equal(replay.ok, true);
  assert.equal(replay.data.session.sessionId, first.data.session.sessionId);

  const conflict = await reloaded.handle(request('work_session.open', {
    projectId: 'different-project', workspaceRoot: repo, repositoryPath: repo,
  }, { idempotencyKey: 'idem-stable' }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'IDEMPOTENCY_KEY_CONFLICT');
});
