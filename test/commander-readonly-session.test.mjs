import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommanderAgentClient } from '../src/commander/agent/client.mjs';
import { CommanderReadOnlyPolicy, phase3ReadCapabilities } from '../src/commander/agent/read-policy.mjs';
import { CommanderReadOnlyDispatcher } from '../src/commander/agent/readonly-dispatcher.mjs';
import { protocolEnvelope } from '../src/commander/contracts/index.mjs';
import { CommanderGatewayServer } from '../src/commander/gateway/server.mjs';

const secret = 'phase3-secret-material-'.repeat(2);
const silentLogger = { info() {}, warn() {}, error() {} };

function waitForState(agent, wanted, timeoutMs = 3_000) {
  if (agent.state === wanted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { agent.off('state', handler); reject(new Error(`timeout:${wanted}`)); }, timeoutMs);
    const handler = (state) => {
      if (state !== wanted) return;
      clearTimeout(timer);
      agent.off('state', handler);
      resolve();
    };
    agent.on('state', handler);
  });
}

function request(operation, params, extra = {}) {
  return { ...protocolEnvelope(), requestId: `req-${Date.now()}-${Math.random().toString(16).slice(2)}`, deviceId: 'phase3-device', operation, params, ...extra };
}

test('authenticated Gateway routes only advertised READ operations to Agent dispatcher', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-phase3-session-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'visible.txt');
  await fs.writeFile(file, 'visible through typed read\n');
  const policy = await CommanderReadOnlyPolicy.create({ version: 1, roots: [root], repositories: [], services: [] });
  const dispatcher = new CommanderReadOnlyDispatcher({ deviceId: 'phase3-device', policy, logger: silentLogger });
  const gateway = new CommanderGatewayServer({
    host: '127.0.0.1', port: 0, heartbeatIntervalMs: 250, heartbeatTimeoutMs: 1_000,
    secretResolver: async (deviceId) => deviceId === 'phase3-device' ? secret : null, logger: silentLogger,
  });
  const address = await gateway.start();
  const agent = new CommanderAgentClient({
    gatewayHost: '127.0.0.1', gatewayPort: address.port,
    identity: { version: 1, deviceId: 'phase3-device', createdAt: new Date().toISOString() },
    secret, capabilities: phase3ReadCapabilities(), operationHandler: (item) => dispatcher.handle(item), logger: silentLogger,
    reconnectBaseMs: 100, reconnectMaxMs: 200, reconnectJitterRatio: 0,
  });
  t.after(async () => { await agent.stop(); await gateway.stop(); });
  const registered = once(agent, 'registered');
  agent.start();
  await registered;
  await waitForState(agent, 'online');

  const health = await gateway.request(request('device.health', {}));
  assert.equal(health.ok, true);
  assert.equal(health.deviceId, 'phase3-device');

  const read = await gateway.request(request('file.read', { path: file }));
  assert.equal(read.ok, true);
  assert.match(read.data.content, /typed read/);

  assert.throws(() => gateway.request(request('file.write', { path: file }, { idempotencyKey: 'idem-session-write-1' })), /gateway_read_only/);
});

test('Gateway rejects a READ operation not advertised by the connected Agent', async (t) => {
  const gateway = new CommanderGatewayServer({
    host: '127.0.0.1', port: 0, heartbeatIntervalMs: 250, heartbeatTimeoutMs: 1_000,
    secretResolver: async () => secret, logger: silentLogger,
  });
  const address = await gateway.start();
  const agent = new CommanderAgentClient({
    gatewayHost: '127.0.0.1', gatewayPort: address.port,
    identity: { version: 1, deviceId: 'phase3-device', createdAt: new Date().toISOString() },
    secret,
    capabilities: [{ operation: 'device.health', authority: 'read', operationVersion: 1 }],
    operationHandler: async () => { throw new Error('should_not_run'); },
    logger: silentLogger,
  });
  t.after(async () => { await agent.stop(); await gateway.stop(); });
  const registered = once(agent, 'registered');
  agent.start();
  await registered;
  assert.throws(() => gateway.request(request('file.read', { path: '/tmp/x' })), /operation_not_advertised/);
});
