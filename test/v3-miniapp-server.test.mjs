import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { protocolEnvelope } from '../src/commander/contracts/index.mjs';
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

async function fixture(projectState, authenticateRequest = () => ({ ok: true }), extras = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-miniapp-'));
  const stateDir = path.join(dir, 'state-v3');
  const store = new JsonStateStore(stateDir);
  await store.init();
  await store.save(projectState.projectId, projectState);
  const telegramStateFile = path.join(stateDir, 'telegram.json');
  await fs.writeFile(telegramStateFile, JSON.stringify({ version: 1, offset: 0, notified: {} }));
  const commanderActivityFile = path.join(dir, 'commander-activity.json');
  if (extras.activityItems) {
    await fs.writeFile(commanderActivityFile, JSON.stringify({ version: 1, items: extras.activityItems }));
  }
  const events = [];
  const control = await controlStub(events);
  const server = createMiniAppServer({
    config,
    store,
    authenticateRequest,
    controlBaseUrl: `http://127.0.0.1:${control.port}`,
    telegramStateFile,
    commanderClient: extras.commanderClient || null,
    commanderActivityFile,
    serviceStatusReader: extras.serviceStatusReader || null,
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


test('Project Control status aggregates Commander devices activity and system services', async () => {
  const now = Date.now();
  const capabilities = [
    'device.health', 'execution.start', 'execution.input', 'execution.get', 'execution.output',
    'file.read', 'file.write', 'service.status', 'service.restart',
    'git.status', 'git.diff', 'git.log',
  ].map((operation) => ({ operation, authority: operation.startsWith('execution.') || ['file.write', 'service.restart'].includes(operation) ? 'write' : 'read', operationVersion: 1 }));
  const commanderClient = {
    listDevices: async () => ({
      devices: [{
        device: {
          ...protocolEnvelope(), deviceId: 'btc-radar', displayName: 'btc-radar', platform: 'linux',
          agentVersion: '0.4.0', sessionId: 'session-btc', connectedAt: new Date(now - 5000).toISOString(),
          capabilities,
        },
        status: 'online',
        connectedAt: now - 5000,
        lastHeartbeatAt: now - 1000,
      }],
    }),
    request: async (request) => ({
      ...protocolEnvelope(),
      requestId: request.requestId,
      deviceId: request.deviceId,
      operation: request.operation,
      ok: true,
      completedAt: new Date(now).toISOString(),
      data: {
        hostname: 'btc-radar',
        uptimeSeconds: 3600,
        loadAverage: [0.1, 0.2, 0.3],
        totalMemoryBytes: 4_000_000_000,
        freeMemoryBytes: 1_500_000_000,
      },
    }),
  };
  const activeUnits = new Set([
    'chatgpt-autopilot-commander-gateway.service',
    'chatgpt-autopilot-commander-github-bridge.service',
    'chatgpt-autopilot-v3.service',
    'chatgpt-autopilot-v3-miniapp.service',
    'chatgpt-autopilot-v3-telegram.service',
  ]);
  const serviceStatusReader = async (unit) => ({
    unit,
    activeState: activeUnits.has(unit) ? 'active' : 'inactive',
    subState: activeUnits.has(unit) ? 'running' : 'dead',
    unitFileState: activeUnits.has(unit) ? 'enabled' : 'disabled',
  });
  const f = await fixture({
    version: 3,
    projectId: 'btc-radar-development',
    status: 'complete',
    task: { id: 'task-complete', title: 'Completed task' },
    stepIndex: 1,
    lastError: '', evidence: [], recentEventIds: [], resumeStatus: '', updatedAt: now,
  }, () => ({ ok: true }), {
    commanderClient,
    serviceStatusReader,
    activityItems: [{
      issueNumber: 500,
      deviceId: 'btc-radar',
      operation: 'terminal.exec',
      ok: true,
      completedAt: new Date(now - 2000).toISOString(),
      state: 'success',
      exitCode: 0,
    }],
  });
  try {
    const response = await fetch(`http://127.0.0.1:${f.port}/api/status`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.version, 4);
    assert.equal(payload.mode, 'project-control');
    assert.equal(payload.commander.state, 'operational');
    assert.equal(payload.commander.onlineDevices, 1);
    assert.equal(payload.commander.devices[0].name, 'BTC Radar');
    assert.equal(payload.commander.devices[0].capabilities.terminal, true);
    assert.equal(payload.commander.devices[0].health.hostname, 'btc-radar');
    assert.equal(payload.commander.activity[0].operation, 'terminal.exec');
    assert.equal(payload.autopilot.infrastructureOnline, true);
    assert.equal(payload.autopilot.automationState, 'idle');
    assert.equal(payload.system.legacyRdcDisabled, true);
    assert.equal(payload.system.secureTunnelDisabled, true);
    assert.equal(payload.system.alerts, 0);
  } finally {
    await cleanup(f);
  }
});

test('Project Control degrades Commander independently when the private Gateway is unavailable', async () => {
  const commanderClient = {
    listDevices: async () => { throw new Error('control_connection_closed'); },
  };
  const f = await fixture({
    version: 3,
    projectId: 'nexolab-development',
    status: 'complete',
    task: { id: 'task-complete', title: 'Completed task' },
    stepIndex: 1,
    lastError: '', evidence: [], recentEventIds: [], resumeStatus: '', updatedAt: Date.now(),
  }, () => ({ ok: true }), { commanderClient });
  try {
    const payload = await (await fetch(`http://127.0.0.1:${f.port}/api/status`)).json();
    assert.equal(payload.commander.state, 'offline');
    assert.equal(payload.commander.devices.length, 0);
    assert.equal(payload.autopilot.projects[0].name, 'NEXOLAB');
  } finally {
    await cleanup(f);
  }
});
