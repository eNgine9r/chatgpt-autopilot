import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { JsonStateStore } from '../src/v3/store.mjs';
import { createMiniAppServer } from '../src/v3/miniapp-server.mjs';

const config = {
  version: 3,
  projects: [
    { id: 'btc-radar-development', enabled: true, steps: [{ id: 'review', action: 'operator.review', approval: 'user' }] },
    { id: 'nexolab-development', enabled: true, steps: [{ id: 'inspect', action: 'repo.inspect' }] },
  ],
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
async function controlStub(events) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const payload = JSON.stringify({ ok: true, version: 3, githubWebhook: true });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    events.push(body);
    const payload = JSON.stringify({ ok: true, state: { status: 'ready' } });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });
  return { server, port: await listen(server) };
}

async function fixture(projectState, authenticateRequest = () => ({ ok: true })) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-miniapp-'));
  const stateDir = path.join(dir, 'state-v3');
  const store = new JsonStateStore(stateDir);
  await store.init();
  await store.save(projectState.projectId, projectState);
  const telegramStateFile = path.join(stateDir, 'telegram.json');
  await fs.writeFile(telegramStateFile, JSON.stringify({ version: 1, offset: 0, notified: {} }));
  const events = [];
  const control = await controlStub(events);
  const server = createMiniAppServer({
    config,
    store,
    authenticateRequest,
    controlBaseUrl: `http://127.0.0.1:${control.port}`,
    telegramStateFile,
    staticDir: path.resolve('web/miniapp'),
  });
  const port = await listen(server);
  return { dir, store, events, control, server, port };
}

async function cleanup(f) {
  await close(f.server);
  await close(f.control.server);
  await fs.rm(f.dir, { recursive: true, force: true });
}

test('v3 Mini App hides API without successful Telegram authentication', async () => {
  const f = await fixture({
    version: 3,
    projectId: 'btc-radar-development',
    status: 'complete',
    task: { id: 'task-1', title: 'Done' },
    stepIndex: 1,
    lastError: '', evidence: [], recentEventIds: [], resumeStatus: '', updatedAt: Date.now(),
  }, () => ({ ok: false, error: 'invalid_signature' }));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${f.port}/`)).status, 200);
    const response = await fetch(`http://127.0.0.1:${f.port}/api/status`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'invalid_signature');
  } finally {
    await cleanup(f);
  }
});

test('v3 Mini App exposes live control status and approval contract', async () => {
  const f = await fixture({
    version: 3,
    projectId: 'btc-radar-development',
    status: 'waiting_approval',
    task: { id: 'task-approve', title: 'BTC Radar approval' },
    stepIndex: 0,
    lastError: '', evidence: [], recentEventIds: [], resumeStatus: '', updatedAt: Date.now(),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${f.port}/api/status`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.aiCalls, 0);
    assert.equal(payload.controlApi.online, true);
    assert.equal(payload.controlApi.localOnly, true);
    assert.equal(payload.githubWebhook.online, true);
    assert.equal(payload.telegramBridge.online, true);
    assert.equal(payload.projects[0].name, 'BTC Radar');
    assert.equal(payload.projects[0].status, 'waiting_approval');
    assert.equal(payload.projects[0].canApprove, true);

    const approved = await fetch(`http://127.0.0.1:${f.port}/api/projects/btc-radar-development/approve`, { method: 'POST' });
    assert.equal(approved.status, 200);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].kind, 'approval.granted');
    assert.equal(f.events[0].stepId, 'review');
  } finally {
    await cleanup(f);
  }
});

test('v3 Mini App allows retry only from blocked state', async () => {
  const f = await fixture({
    version: 3,
    projectId: 'nexolab-development',
    status: 'blocked',
    task: { id: 'task-retry', title: 'NexoLab retry' },
    stepIndex: 0,
    lastError: 'test_failed', evidence: [], recentEventIds: [], resumeStatus: '', updatedAt: Date.now(),
  });
  try {
    const status = await (await fetch(`http://127.0.0.1:${f.port}/api/status`)).json();
    assert.equal(status.projects[0].name, 'NexoLab');
    assert.equal(status.projects[0].canRetry, true);
    assert.equal(status.projects[0].lastError, 'test_failed');

    const retry = await fetch(`http://127.0.0.1:${f.port}/api/projects/nexolab-development/retry`, { method: 'POST' });
    assert.equal(retry.status, 200);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].kind, 'retry');

    const wrong = await fetch(`http://127.0.0.1:${f.port}/api/projects/nexolab-development/approve`, { method: 'POST' });
    assert.equal(wrong.status, 409);
  } finally {
    await cleanup(f);
  }
});
