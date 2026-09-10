import test from 'node:test';
import assert from 'node:assert/strict';
import { CommanderV3Client, CommanderV3Error } from '../src/v3/commander-client.mjs';
import { protocolEnvelope } from '../src/commander/contracts/index.mjs';

const now = '2026-09-10T10:30:00.000Z';

function result(request, data, overrides = {}) {
  return {
    ...protocolEnvelope(),
    requestId: request.requestId,
    deviceId: request.deviceId,
    operation: request.operation,
    ok: true,
    completedAt: now,
    data,
    ...overrides,
  };
}

function project() {
  return {
    id: 'demo',
    repoPath: '/fallback/demo',
    commander: {
      enabled: true,
      deviceId: 'device-a',
      repoPath: '/srv/demo',
      testAliases: { required: 'v3-required' },
    },
    tests: { required: { command: 'node', args: ['--version'], timeoutMs: 1000 } },
  };
}

test('Commander v3 repo.inspect uses structured git operations and normalized evidence', async () => {
  const seen = [];
  const publicClient = {
    async request(request) {
      seen.push(request);
      if (request.operation === 'git.status') {
        return result(request, { repo: '/srv/demo', branch: 'main...origin/main', changes: [' M tracked.txt', '?? scratch.txt'], truncated: false });
      }
      if (request.operation === 'git.log') {
        return result(request, { repo: '/srv/demo', commits: [{ sha: 'a'.repeat(40), authoredAt: now, subject: 'head' }], truncated: false });
      }
      throw new Error(`unexpected:${request.operation}`);
    },
  };
  const client = new CommanderV3Client({ client: publicClient });
  const evidence = JSON.parse(await client.execute(project(), {
    projectId: 'demo', taskId: 'task-1', stepId: 'inspect', attempt: 1, action: 'repo.inspect', params: {},
  }));
  assert.equal(evidence.backend, 'commander');
  assert.equal(evidence.deviceId, 'device-a');
  assert.equal(evidence.head, 'a'.repeat(40));
  assert.equal(evidence.branch, 'main');
  assert.equal(evidence.cleanTracked, false);
  assert.equal(evidence.trackedStatus, ' M tracked.txt');
  assert.deepEqual(seen.map((item) => item.operation), ['git.status', 'git.log']);
  assert.deepEqual(seen.map((item) => item.params.repo), ['/srv/demo', '/srv/demo']);
});

test('Commander v3 repo.test starts once, polls structured execution state and returns bounded output evidence', async () => {
  const seen = [];
  const executionId = 'exec-1';
  let polls = 0;
  const publicClient = {
    async request(request) {
      seen.push(request);
      if (request.operation === 'execution.start') {
        return result(request, { execution: { executionId, state: 'running', updatedAt: now } });
      }
      if (request.operation === 'execution.get') {
        polls += 1;
        return result(request, { execution: { executionId, state: polls < 2 ? 'running' : 'success', exitCode: 0, updatedAt: now } });
      }
      if (request.operation === 'execution.output') {
        return result(request, {
          events: [
            { type: 'stdout', payload: { chunk: 'PASS' } },
            { type: 'stderr', payload: { chunk: '' } },
          ],
          truncated: false,
          totalBytes: 4,
        });
      }
      throw new Error(`unexpected:${request.operation}`);
    },
  };
  const client = new CommanderV3Client({ client: publicClient, sleep: async () => {}, pollIntervalMs: 25 });
  const dispatch = { projectId: 'demo', taskId: 'task-1', stepId: 'test', attempt: 1, action: 'repo.test', params: { alias: 'required' } };
  const evidence = JSON.parse(await client.execute(project(), dispatch));
  assert.equal(evidence.backend, 'commander');
  assert.equal(evidence.commanderAlias, 'v3-required');
  assert.equal(evidence.executionId, executionId);
  assert.equal(evidence.state, 'success');
  assert.equal(evidence.stdout, 'PASS');
  const start = seen.find((item) => item.operation === 'execution.start');
  assert.equal(start.params.alias, 'v3-required');
  assert.match(start.idempotencyKey, /^v3-[0-9a-f]{64}$/);
  assert.ok(start.deadlineAt);
});

test('structured Commander denial becomes sanitized deterministic v3 failure', async () => {
  const publicClient = {
    async request(request) {
      return {
        ...protocolEnvelope(), requestId: request.requestId, deviceId: request.deviceId, operation: request.operation,
        ok: false, completedAt: now,
        error: {
          ...protocolEnvelope(), category: 'authorization', code: 'REQUIRES_APPROVAL',
          message: 'Explicit approval is required before mutation.', retryable: true,
        },
      };
    },
  };
  const client = new CommanderV3Client({ client: publicClient });
  await assert.rejects(
    client.execute(project(), { projectId: 'demo', taskId: 'task-1', stepId: 'test', attempt: 1, action: 'repo.test', params: { alias: 'required' } }),
    (error) => error instanceof CommanderV3Error
      && error.failure.category === 'approval'
      && error.failure.code === 'REQUIRES_APPROVAL'
      && error.failure.newAttempt === true
      && !error.message.includes('Explicit approval'),
  );
});

test('ambiguous Commander transport failure is marked for same-attempt retry', async () => {
  const publicClient = { async request() { throw new Error('socket exploded with secret detail'); } };
  const client = new CommanderV3Client({ client: publicClient });
  await assert.rejects(
    client.execute(project(), { projectId: 'demo', taskId: 'task-1', stepId: 'inspect', attempt: 1, action: 'repo.inspect', params: {} }),
    (error) => error instanceof CommanderV3Error
      && error.failure.category === 'transport'
      && error.failure.code === 'COMMANDER_UNAVAILABLE'
      && error.failure.newAttempt === false
      && !error.message.includes('secret detail'),
  );
});

test('Commander mutation key is stable within one durable attempt and rotates for a new attempt', async () => {
  const startKeys = [];
  let executionCounter = 0;
  const publicClient = {
    async request(request) {
      if (request.operation === 'execution.start') {
        startKeys.push(request.idempotencyKey);
        executionCounter += 1;
        return result(request, { execution: { executionId: `exec-${executionCounter}`, state: 'success', exitCode: 0, updatedAt: now } });
      }
      if (request.operation === 'execution.output') {
        return result(request, { events: [], truncated: false, totalBytes: 0 });
      }
      throw new Error(`unexpected:${request.operation}`);
    },
  };
  const client = new CommanderV3Client({ client: publicClient, sleep: async () => {} });
  const base = { projectId: 'demo', taskId: 'task-stable', stepId: 'test', action: 'repo.test', params: { alias: 'required' } };
  await client.execute(project(), { ...base, attempt: 1 });
  await client.execute(project(), { ...base, attempt: 1 });
  await client.execute(project(), { ...base, attempt: 2 });
  assert.equal(startKeys[0], startKeys[1]);
  assert.notEqual(startKeys[1], startKeys[2]);
});
