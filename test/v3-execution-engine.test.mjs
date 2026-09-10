import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStateStore } from '../src/v3/store.mjs';
import { Orchestrator } from '../src/v3/orchestrator.mjs';
import { ExecutionEngine } from '../src/v3/execution-engine.mjs';

const config = {
  version: 3,
  projects: [{
    id: 'demo', enabled: true, repoPath: '/tmp/demo',
    tests: { required: { command: 'node', args: ['--version'] } },
    steps: [
      { id: 'inspect', action: 'repo.inspect' },
      { id: 'test', action: 'repo.test', params: { alias: 'required' } },
      { id: 'review', action: 'operator.review', approval: 'user' },
    ],
  }],
};

async function engine(t, executor) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-engine-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ExecutionEngine(new Orchestrator(config, new JsonStateStore(root)), executor);
}

test('one external task event batches deterministic actions until approval', async (t) => {
  const seen = [];
  const runner = await engine(t, {
    async execute(_project, dispatch) {
      seen.push(dispatch.action);
      return `${dispatch.stepId}:pass`;
    },
  });
  const result = await runner.handle({ id: 'task-1', projectId: 'demo', kind: 'task.received' });
  assert.deepEqual(seen, ['repo.inspect', 'repo.test']);
  assert.equal(result.autoSteps, 2);
  assert.equal(result.state.status, 'waiting_approval');
  assert.equal(result.state.stepIndex, 2);
});

test('executor failure becomes durable blocked state', async (t) => {
  const runner = await engine(t, {
    async execute(_project, dispatch) {
      if (dispatch.action === 'repo.test') throw new Error('tests_failed');
      return 'inspect:pass';
    },
  });
  const result = await runner.handle({ id: 'task-2', projectId: 'demo', kind: 'task.received' });
  assert.equal(result.state.status, 'blocked');
  assert.match(result.state.lastError, /tests_failed/);
  assert.equal(result.autoSteps, 2);
});

test('Commander structured failure becomes durable blocked state without raw transport detail', async (t) => {
  const runner = await engine(t, {
    async execute() {
      const error = new Error('raw socket detail must not persist');
      error.failure = {
        backend: 'commander', category: 'device_offline', code: 'DEVICE_OFFLINE', retryable: true,
        deviceId: 'device-a', operation: 'git.status', newAttempt: false,
      };
      throw error;
    },
  });
  const result = await runner.handle({ id: 'task-commander-down', projectId: 'demo', kind: 'task.received' });
  assert.equal(result.state.status, 'blocked');
  assert.equal(result.state.lastError, 'commander:device_offline:DEVICE_OFFLINE');
  assert.equal(result.state.lastFailure.deviceId, 'device-a');
  assert.equal(result.state.lastFailure.newAttempt, false);
  assert.equal(JSON.stringify(result.state).includes('raw socket detail'), false);
});
