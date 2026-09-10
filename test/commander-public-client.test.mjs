import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  operationDefinition,
  protocolEnvelope,
} from '../src/commander/contracts/index.mjs';
import { CommanderPublicClient, CommanderPublicClientError } from '../src/commander/client/index.mjs';
import { CommanderControlServer } from '../src/commander/gateway/control-server.mjs';

const now = new Date('2026-09-10T09:00:00Z');

function capability(operation) {
  const definition = operationDefinition(operation);
  return { operation, authority: definition.authority, operationVersion: definition.operationVersion };
}

function deviceEntry() {
  return {
    device: {
      ...protocolEnvelope(),
      deviceId: 'device-a',
      displayName: 'Device A',
      platform: 'linux',
      agentVersion: '0.1.0',
      sessionId: 'session-a',
      connectedAt: now.toISOString(),
      capabilities: [capability('device.health'), capability('execution.start'), capability('system.reboot')],
    },
    sessionId: 'session-a',
    connection: {},
    status: 'online',
    connectedAt: now.getTime(),
    lastHeartbeatAt: now.getTime(),
    heartbeatSequence: 1,
  };
}

function success(request) {
  return {
    ...protocolEnvelope(),
    requestId: request.requestId,
    deviceId: request.deviceId,
    operation: request.operation,
    ok: true,
    completedAt: now.toISOString(),
    data: { healthy: true },
  };
}

async function fixture(t, { authorities = ['read'], requestImpl = async (request) => success(request) } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-control-'));
  const socketPath = path.join(root, 'runtime', 'gateway.sock');
  const entry = deviceEntry();
  const gateway = {
    allowedAuthorities: new Set(authorities),
    registry: {
      get(deviceId) { return deviceId === entry.device.deviceId ? entry : null; },
      list() { return [entry]; },
    },
    request: requestImpl,
  };
  const server = new CommanderControlServer({ gateway, socketPath, logger: { info() {}, warn() {}, error() {} } });
  await server.start();
  t.after(async () => {
    await server.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, socketPath, server, gateway, client: new CommanderPublicClient({ socketPath }) };
}

test('private Commander control API is local, permission-bounded and authority-filtered', async (t) => {
  const { root, socketPath, client } = await fixture(t);
  const socketStat = await fs.stat(socketPath);
  const parentStat = await fs.stat(path.dirname(socketPath));
  assert.equal(socketStat.mode & 0o777, 0o600);
  assert.equal(parentStat.mode & 0o777, 0o700);

  const listed = await client.listDevices();
  assert.equal(listed.devices.length, 1);
  assert.deepEqual(listed.devices[0].device.capabilities.map((item) => item.operation), ['device.health']);
  assert.equal('connection' in listed.devices[0], false);

  const device = await client.getDevice('device-a');
  assert.deepEqual(device.device.capabilities.map((item) => item.operation), ['device.health']);
  assert.equal(path.dirname(socketPath).startsWith(root), true);
});

test('Commander public client preserves validated OperationResult and structured failures', async (t) => {
  let seen;
  const { client } = await fixture(t, {
    authorities: ['read', 'write'],
    requestImpl: async (request) => {
      seen = request;
      if (request.operation === 'execution.start') throw new Error('gateway_read_only');
      return success(request);
    },
  });

  const readRequest = {
    ...protocolEnvelope(), requestId: 'req-read', deviceId: 'device-a', operation: 'device.health', params: {},
  };
  const result = await client.request(readRequest, { timeoutMs: 1_000 });
  assert.equal(result.ok, true);
  assert.equal(seen.requestId, 'req-read');

  const writeRequest = {
    ...protocolEnvelope(), requestId: 'req-write', deviceId: 'device-a', operation: 'execution.start', params: {}, idempotencyKey: 'idem-1',
  };
  await assert.rejects(
    client.request(writeRequest, { timeoutMs: 1_000 }),
    (error) => error instanceof CommanderPublicClientError
      && error.commanderError?.code === 'GATEWAY_WRITE_DISABLED'
      && error.commanderError?.category === 'authorization',
  );
});

test('active Commander control socket fails closed instead of being unlinked', async (t) => {
  const { socketPath } = await fixture(t);
  const entry = deviceEntry();
  const second = new CommanderControlServer({
    socketPath,
    gateway: {
      allowedAuthorities: new Set(['read']),
      registry: { get: () => entry, list: () => [entry] },
      request: async (request) => success(request),
    },
  });
  await assert.rejects(second.start(), /control_socket_in_use/);
});
