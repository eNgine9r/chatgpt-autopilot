import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { V3CodingWorker, runToken } from '../src/v3/coding-worker.mjs';

const project = {
  id: 'nexolab-development',
  github: { repository: 'eNgine9r/nexolab-platform' },
  transport: { type: 'ssh-gateway', host: 'nexo', user: 'nexolab', identityFile: '/tmp/key' },
  coding: {
    enabled: true, mode: 'shadow', timeoutMs: 200,
    approvalPolicy: 'on-request', networkAccess: false,
    instructions: 'Implement only the scoped issue and do not deploy.',
    codexTransport: { type: 'ssh', host: 'nexo', user: 'nexolab', identityFile: '/tmp/codex-key' },
  },
};

const dispatch = {
  stepId: 'coding', attempt: 1,
  task: {
    id: 'github:eNgine9r/nexolab-platform#174', source: 'github',
    repository: 'eNgine9r/nexolab-platform', issueNumber: 174,
    title: 'Bounded coding worker', body: 'Implement the scoped shadow worker.',
  },
};class FakeClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.requests = [];
    this.responses = [];
    this.closed = false;
  }
  async start() {}
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thr-shadow' } };
    if (method === 'turn/start') {
      const id = 'turn-shadow';
      if (this.options.turnFailure) {
        queueMicrotask(() => this.emit('notification', { method: 'turn/completed', params: { turn: {
          id, status: 'failed', error: { message: this.options.turnFailure },
        } } }));
        return { turn: { id } };
      }
      if (this.options.exit) queueMicrotask(() => this.emit('exit', new Error('boom')));
      else if (!this.options.stall) queueMicrotask(() => {
        this.emit('notification', { method: 'item/completed', params: { item: {
          type: 'agentMessage', text: this.options.agentText ?? 'implemented safely',
        } } });
        this.emit('notification', { method: 'turn/completed', params: { turn: { id, status: 'completed' } } });
      });
      return { turn: { id } };
    }
    throw new Error(`unexpected_request:${method}`);
  }
  respond(id, result) { this.responses.push({ id, result }); }
  async close() { this.closed = true; }
}

async function fixture(t, options = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v3-coding-worker-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const operations = [];
  const clients = [];
  const runner = async (_command, args) => {
    const operation = args.at(-1);
    operations.push(operation);
    const [kind, issueText, token] = operation.split(' ');
    const issue = Number(issueText || 0);
    const identity = {
      ok: true,
      issue,
      token,
      branch: `autopilot-shadow/${issue}-${token}`,
      worktreePath: `/tmp/issue-${issue}-${token}`,
      baseHead: 'a'.repeat(40),
    };
    if (kind === 'coding-prepare') return { stdout: JSON.stringify(identity) };
    if (kind === 'coding-inspect') return { stdout: JSON.stringify({
      head: 'a'.repeat(40), headChanged: false, dirty: true, changedFiles: ['src/demo.js'],
      ...(options.inspect ?? {}),
      ...identity,
    }) };
    if (kind === 'coding-cleanup') return { stdout: JSON.stringify({ ok: true, removed: true }) };
    throw new Error(`unexpected_operation:${operation}`);
  };
  const clientFactory = () => {
    const client = new FakeClient(options.client ?? {});
    clients.push(client);
    return client;
  };
  const worker = new V3CodingWorker({ stateDir, runner, clientFactory });
  return { worker, operations, clients, stateDir };
}

test('one-shot coding run uses one Codex turn and returns bounded shadow evidence', async (t) => {
  const { worker, operations, clients } = await fixture(t);
  const result = JSON.parse(await worker.execute(project, dispatch));
  assert.equal(result.mode, 'shadow');
  assert.equal(result.issueNumber, 174);
  assert.equal(result.dirty, true);
  assert.deepEqual(result.changedFiles, ['src/demo.js']);
  assert.equal(result.worktreeRetained, true);
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0].requests.map((row) => row.method), ['thread/start', 'turn/start']);
  assert.match(clients[0].requests[1].params.input[0].text, /GitHub issue: #174/);
  assert.ok(operations.some((item) => item.startsWith('coding-prepare 174 ')));
  assert.ok(operations.some((item) => item.startsWith('coding-inspect 174 ')));
  assert.equal(operations.some((item) => item.startsWith('coding-cleanup ')), false);
});

test('successful attempt is durable and never invokes Codex twice', async (t) => {
  const { worker, operations, clients } = await fixture(t);
  const first = JSON.parse(await worker.execute(project, dispatch));
  const second = JSON.parse(await worker.execute(project, dispatch));
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.token, first.token);
  assert.equal(clients.length, 1);
  assert.equal(operations.filter((item) => item.startsWith('coding-prepare ')).length, 1);
  assert.equal(runToken(project, dispatch), first.token);
});test('clean successful shadow run is automatically disposed', async (t) => {
  const { worker, operations } = await fixture(t, { inspect: {
    ok: true, branch: 'autopilot-shadow/174-token', worktreePath: '/tmp/shadow-174',
    baseHead: 'a'.repeat(40), head: 'a'.repeat(40), headChanged: false,
    dirty: false, changedFiles: [],
  } });
  const result = JSON.parse(await worker.execute(project, dispatch));
  assert.equal(result.worktreeRetained, false);
  assert.ok(operations.some((item) => item.startsWith('coding-cleanup 174 ')));
});

test('agent output and changed-file evidence remain bounded valid JSON', async (t) => {
  const changedFiles = Array.from({ length: 100 }, (_, i) => `src/${String(i).padStart(3, '0')}-${'x'.repeat(300)}.js`);
  const { worker } = await fixture(t, {
    client: { agentText: 'A'.repeat(50000) },
    inspect: {
      ok: true, branch: 'autopilot-shadow/174-token', worktreePath: '/tmp/shadow-174',
      baseHead: 'a'.repeat(40), head: 'a'.repeat(40), headChanged: false,
      dirty: true, changedFiles,
    },
  });
  const text = await worker.execute(project, dispatch);
  assert.ok(text.length <= 12000);
  const result = JSON.parse(text);
  assert.ok(result.agentExcerpt.length <= 3501);
  assert.equal(result.changedFiles.length, 25);
  assert.equal(result.changedFilesTruncated, true);
});

test('timeout fails once and same attempt cannot silently rerun', async (t) => {
  const slowProject = { ...project, coding: { ...project.coding, timeoutMs: 20 } };
  const { worker, clients } = await fixture(t, { client: { stall: true } });
  await assert.rejects(() => worker.execute(slowProject, dispatch), /CODING_TIMEOUT/);
  await assert.rejects(() => worker.execute(slowProject, dispatch), /CODING_PREVIOUS_FAILURE/);
  assert.equal(clients.length, 1);
});test('Codex account capacity exhaustion is retryable but same attempt remains one-shot', async (t) => {
  const { worker, clients } = await fixture(t, { client: {
    turnFailure: 'Usage limit reached. Purchase more credits or try again at Sep 19th, 2026 5:15 PM.',
  } });
  await assert.rejects(() => worker.execute(project, dispatch), (error) => {
    assert.equal(error.failure?.code, 'CODING_CAPACITY_EXHAUSTED');
    assert.equal(error.failure?.retryable, true);
    return true;
  });
  await assert.rejects(() => worker.execute(project, dispatch), /CODING_PREVIOUS_FAILURE/);
  assert.equal(clients.length, 1);
});

test('unexpected Codex exit is retryable but does not rerun the same attempt', async (t) => {
  const { worker, clients } = await fixture(t, { client: { exit: true } });
  await assert.rejects(() => worker.execute(project, dispatch), (error) => {
    assert.equal(error.failure?.code, 'CODING_UNEXPECTED_EXIT');
    assert.equal(error.failure?.retryable, true);
    return true;
  });
  await assert.rejects(() => worker.execute(project, dispatch), /CODING_PREVIOUS_FAILURE/);
  assert.equal(clients.length, 1);
});

test('git history mutation fails closed and retains non-disposable shadow evidence', async (t) => {
  const { worker, operations } = await fixture(t, { inspect: {
    ok: true, branch: 'autopilot-shadow/174-token', worktreePath: '/tmp/shadow-174',
    baseHead: 'a'.repeat(40), head: 'b'.repeat(40), headChanged: true,
    dirty: false, changedFiles: [],
  } });
  await assert.rejects(() => worker.execute(project, dispatch), /CODING_GIT_HISTORY_CHANGED/);
  assert.ok(operations.some((item) => item.startsWith('coding-cleanup 174 ')));
});

test('coding worker fails closed for disabled or non-GitHub tasks', async (t) => {
  const { worker } = await fixture(t);
  await assert.rejects(() => worker.execute({ ...project, coding: { ...project.coding, enabled: false } }, dispatch), /CODING_DISABLED/);
  await assert.rejects(() => worker.execute(project, { ...dispatch, task: { ...dispatch.task, source: 'manual' } }), /CODING_TASK_SOURCE_INVALID/);
});

test('concurrent duplicate attempt is rejected before a second Codex client starts', async (t) => {
  const concurrentProject = { ...project, coding: { ...project.coding, timeoutMs: 60 } };
  const { worker, clients } = await fixture(t, { client: { stall: true } });
  const first = worker.execute(concurrentProject, dispatch);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(() => worker.execute(concurrentProject, dispatch), /CODING_RUN_ALREADY_ACTIVE/);
  await assert.rejects(() => first, /CODING_TIMEOUT/);
  assert.equal(clients.length, 1);
});