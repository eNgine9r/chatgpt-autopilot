import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { CommanderAgentClient, reconnectDelayMs } from '../src/commander/agent/client.mjs';
import { CommanderGatewayServer } from '../src/commander/gateway/server.mjs';

const secret = 'correct-secret-material-'.repeat(2);
const identity = { version: 1, deviceId: 'test-device', createdAt: new Date().toISOString() };
const silentLogger = { info() {}, warn() {}, error() {} };

async function waitForEvent(emitter, event, timeoutMs = 3_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await once(emitter, event, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function waitForState(agent, wanted, timeoutMs = 3_000) {
  if (agent.state === wanted) return Promise.resolve(wanted);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      agent.off('state', handler);
      reject(new Error(`state_timeout:${wanted}:${agent.state}`));
    }, timeoutMs);
    const handler = (state) => {
      if (state !== wanted) return;
      clearTimeout(timer);
      agent.off('state', handler);
      resolve(state);
    };
    agent.on('state', handler);
  });
}

test('reconnect backoff is bounded and supports deterministic jitter', () => {
  assert.equal(reconnectDelayMs(0, { baseMs: 100, maxMs: 800, jitterRatio: 0, random: () => 0.5 }), 100);
  assert.equal(reconnectDelayMs(3, { baseMs: 100, maxMs: 800, jitterRatio: 0, random: () => 0.5 }), 800);
  assert.equal(reconnectDelayMs(20, { baseMs: 100, maxMs: 800, jitterRatio: 0, random: () => 0.5 }), 800);
  assert.throws(() => reconnectDelayMs(-1), /invalid_reconnect_policy/);
});


test('Gateway class itself rejects non-loopback Phase 2 binding', () => {
  assert.throws(() => new CommanderGatewayServer({ host: '0.0.0.0', secretResolver: async () => secret }), /phase2_gateway_must_be_loopback/);
});


test('Gateway private binding is opt-in and tied to the injected tailscale0 address', () => {
  const networkInterfaces = {
    tailscale0: [{ address: '100.72.160.97', family: 'IPv4', internal: false }],
    eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
  };
  const gateway = new CommanderGatewayServer({
    host: '100.72.160.97',
    privateBindEnabled: true,
    networkInterfaces,
    secretResolver: async () => secret,
  });
  assert.equal(gateway.host, '100.72.160.97');
  assert.throws(() => new CommanderGatewayServer({
    host: '192.168.1.20', privateBindEnabled: true, networkInterfaces, secretResolver: async () => secret,
  }), /not_tailscale0/);
});

test('Agent authenticates, heartbeats and reconnects with a new session after Gateway restart', async (t) => {
  let gateway = new CommanderGatewayServer({
    host: '127.0.0.1', port: 0,
    heartbeatIntervalMs: 250, heartbeatTimeoutMs: 1_000,
    secretResolver: async (deviceId) => deviceId === identity.deviceId ? secret : null,
    logger: silentLogger,
  });
  const address = await gateway.start();
  const agent = new CommanderAgentClient({
    gatewayHost: '127.0.0.1', gatewayPort: address.port,
    identity, secret, logger: silentLogger,
    reconnectBaseMs: 100, reconnectMaxMs: 200, reconnectJitterRatio: 0,
  });
  t.after(async () => { await agent.stop(); await gateway.stop(); });

  const firstRegistered = waitForEvent(agent, 'registered');
  const firstAck = waitForEvent(agent, 'heartbeatAck');
  agent.start();
  const [{ sessionId: firstSession }] = await firstRegistered;
  await firstAck;
  assert.equal(agent.state, 'online');
  assert.equal(gateway.registry.get(identity.deviceId).status, 'online');
  assert.equal(gateway.registry.get(identity.deviceId).sessionId, firstSession);

  const disconnected = waitForState(agent, 'disconnected');
  const port = address.port;
  await gateway.stop();
  await disconnected;

  const secondRegistered = waitForEvent(agent, 'registered', 5_000);
  const replacement = new CommanderGatewayServer({
    host: '127.0.0.1', port,
    heartbeatIntervalMs: 250, heartbeatTimeoutMs: 1_000,
    secretResolver: async (deviceId) => deviceId === identity.deviceId ? secret : null,
    logger: silentLogger,
  });
  gateway = replacement;
  await replacement.start();
  const [{ sessionId: secondSession }] = await secondRegistered;
  assert.notEqual(secondSession, firstSession);
  assert.equal(agent.state, 'online');
  assert.equal(replacement.registry.get(identity.deviceId).sessionId, secondSession);
});

test('wrong Agent secret never registers and stop prevents reconnect', async (t) => {
  const gateway = new CommanderGatewayServer({
    host: '127.0.0.1', port: 0,
    heartbeatIntervalMs: 250, heartbeatTimeoutMs: 1_000,
    secretResolver: async () => secret,
    logger: silentLogger,
  });
  const address = await gateway.start();
  const agent = new CommanderAgentClient({
    gatewayHost: '127.0.0.1', gatewayPort: address.port,
    identity, secret: 'wrong-secret-material-'.repeat(2), logger: silentLogger,
    reconnectBaseMs: 500, reconnectMaxMs: 500, reconnectJitterRatio: 0,
  });
  t.after(async () => { await agent.stop(); await gateway.stop(); });
  agent.start();
  await waitForState(agent, 'disconnected');
  assert.equal(gateway.registry.get(identity.deviceId), null);
  await agent.stop();
  assert.equal(agent.state, 'stopped');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(agent.state, 'stopped');
  assert.equal(agent.socket, null);
});
