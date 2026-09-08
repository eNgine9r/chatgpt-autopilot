import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStateStore } from '../src/v3/store.mjs';
import { Orchestrator } from '../src/v3/orchestrator.mjs';
import { DeterministicExecutor } from '../src/v3/executor.mjs';
import { ExecutionEngine } from '../src/v3/execution-engine.mjs';
import { createControlServer, createGitHubServer } from '../src/v3/http-servers.mjs';

const secret = '0123456789abcdef0123456789abcdef';
const config = {
  version: 3,
  projects: [{
    id: 'demo',
    enabled: true,
    github: { repository: 'eNgine9r/demo', taskLabels: ['autopilot'] },
    tests: {},
    steps: [{ id: 'review', action: 'operator.review', approval: 'user' }],
  }],
};

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function signedHeaders(body, delivery = 'delivery-split') {
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  return {
    'content-type': 'application/json',
    'x-github-event': 'issues',
    'x-github-delivery': delivery,
    'x-hub-signature-256': signature,
  };
}

function issueBody() {
  return JSON.stringify({
    action: 'opened',
    repository: { full_name: 'eNgine9r/demo' },
    issue: {
      number: 7,
      title: 'Split ingress acceptance',
      html_url: 'https://github.com/eNgine9r/demo/issues/7',
      labels: [{ name: 'autopilot' }],
    },
  });
}

test('control and GitHub listeners expose disjoint surfaces', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-http-'));
  const store = new JsonStateStore(dir);
  await store.init();
  const orchestrator = new Orchestrator(config, store);
  const engine = new ExecutionEngine(orchestrator, new DeterministicExecutor());
  const control = createControlServer({ store, engine, githubWebhook: true });
  const github = createGitHubServer({ config, engine, webhookSecret: secret });
  const controlPort = await listen(control);
  const githubPort = await listen(github);

  try {
    const health = await fetch(`http://127.0.0.1:${controlPort}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).githubWebhook, true);

    assert.equal((await fetch(`http://127.0.0.1:${controlPort}/github`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${githubPort}/events`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${githubPort}/projects`)).status, 404);

    const unsigned = await fetch(`http://127.0.0.1:${githubPort}/github`, {
      method: 'POST',
      body: issueBody(),
    });
    assert.equal(unsigned.status, 401);

    const body = issueBody();
    const accepted = await fetch(`http://127.0.0.1:${githubPort}/github`, {
      method: 'POST',
      headers: signedHeaders(body),
      body,
    });
    assert.equal(accepted.status, 200);
    const result = await accepted.json();
    assert.equal(result.accepted, true);
    assert.equal(result.state.status, 'waiting_approval');
    assert.equal(result.state.task.id, 'github:eNgine9r/demo#7');
  } finally {
    await close(control);
    await close(github);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('GitHub listener is absent without a webhook secret', () => {
  assert.equal(createGitHubServer({ config, engine: {}, webhookSecret: '' }), null);
});
