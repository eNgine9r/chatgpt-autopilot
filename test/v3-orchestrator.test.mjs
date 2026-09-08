import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStateStore } from '../src/v3/store.mjs';
import { Orchestrator } from '../src/v3/orchestrator.mjs';

const config = {
  version: 3,
  projects: [{
    id: 'demo', enabled: true,
    steps: [
      { id: 'inspect', action: 'repo.inspect', params: { readOnly: true } },
      { id: 'review', action: 'operator.review', approval: 'user' },
    ],
  }],
};

test('orchestrator emits deterministic dispatch without AI', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const orchestrator = new Orchestrator(config, new JsonStateStore(root));
  const result = await orchestrator.handle({ id: '1', projectId: 'demo', kind: 'task.received' });
  assert.deepEqual(result.dispatch, {
    projectId: 'demo', stepId: 'inspect', action: 'repo.inspect', params: { readOnly: true },
  });
  assert.equal(result.state.status, 'ready');
});
