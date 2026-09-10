import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import {
  operationDefinition,
  protocolEnvelope,
} from '../src/commander/contracts/index.mjs';
import { CommanderControlServer } from '../src/commander/gateway/control-server.mjs';
import { buildCommanderMcpServer } from '../src/integrations/mcp/commander/server.mjs';

const now = '2026-09-10T09:00:00Z';

function capability(operation) {
  const definition = operationDefinition(operation);
  return { operation, authority: definition.authority, operationVersion: definition.operationVersion };
}

function entry(capabilities = [capability('device.health'), capability('execution.start'), capability('system.reboot')]) {
  return {
    status: 'online',
    connectedAt: now,
    lastHeartbeatAt: now,
    device: {
      ...protocolEnvelope(),
      deviceId: 'device-a', displayName: 'Device A', platform: 'linux', agentVersion: '0.1.0',
      sessionId: 'session-a', connectedAt: now, capabilities,
    },
  };
}

function okResult(request) {
  return {
    ...protocolEnvelope(), requestId: request.requestId, deviceId: request.deviceId, operation: request.operation,
    ok: true, completedAt: now, data: { accepted: true },
  };
}

async function connectedInMemory(t, publicClient, snapshot = entry()) {
  const server = buildCommanderMcpServer({ client: publicClient, deviceId: 'device-a', deviceEntry: snapshot });
  const client = new Client(
    { name: 'commander-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'modern' } },
  );
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('MCP advertises only enabled non-admin Commander capabilities and routes through public client', async (t) => {
  let current = entry();
  const requests = [];
  const publicClient = {
    getDevice: async () => current,
    request: async (request) => { requests.push(request); return okResult(request); },
  };
  const client = await connectedInMemory(t, publicClient, current);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'commander_v1_device_health',
    'commander_v1_execution_start',
  ]);
  assert.equal(tools.some((tool) => tool.name.includes('system_reboot')), false);

  const read = await client.callTool({ name: 'commander_v1_device_health', arguments: { params: {} } });
  assert.equal(read.structuredContent.ok, true);
  assert.equal(requests.at(-1).operation, 'device.health');
  assert.match(requests.at(-1).requestId, /^mcp-/);

  const writeTool = tools.find((tool) => tool.name === 'commander_v1_execution_start');
  assert.equal(writeTool.inputSchema.required.includes('idempotencyKey'), true);
  const write = await client.callTool({
    name: 'commander_v1_execution_start',
    arguments: { params: { alias: 'diagnostics' }, idempotencyKey: 'idem-mcp-1', timeoutMs: 1_000 },
  });
  assert.equal(write.structuredContent.ok, true);
  assert.equal(requests.at(-1).idempotencyKey, 'idem-mcp-1');
  assert.equal(requests.at(-1).operation, 'execution.start');

  current = entry([capability('device.health')]);
  const callsBeforeRevoked = requests.length;
  const revoked = await client.callTool({
    name: 'commander_v1_execution_start',
    arguments: { params: {}, idempotencyKey: 'idem-mcp-2' },
  });
  assert.equal(revoked.isError, true);
  assert.equal(revoked.structuredContent.error.code, 'OPERATION_NOT_ADVERTISED');
  assert.equal(requests.length, callsBeforeRevoked);
});

test('MCP sanitizes unexpected public-client failures and never leaks raw error text', async (t) => {
  const publicClient = {
    getDevice: async () => entry([capability('device.health')]),
    request: async () => { throw new Error('TOP-SECRET-DO-NOT-LEAK'); },
  };
  const client = await connectedInMemory(t, publicClient, entry([capability('device.health')]));
  const result = await client.callTool({ name: 'commander_v1_device_health', arguments: { params: {} } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'MCP_COMMANDER_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('TOP-SECRET-DO-NOT-LEAK'), false);
});

test('stdio adapter interoperates with modern MCP over the private Commander public boundary', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-mcp-stdio-'));
  const socketPath = path.join(root, 'runtime', 'gateway.sock');
  const snapshot = entry([capability('device.health')]);
  const gateway = {
    allowedAuthorities: new Set(['read']),
    registry: {
      get: (deviceId) => deviceId === 'device-a' ? {
        ...snapshot,
        connectedAt: Date.parse(snapshot.connectedAt),
        lastHeartbeatAt: Date.parse(snapshot.lastHeartbeatAt),
      } : null,
      list: () => [],
    },
    request: async (request) => okResult(request),
  };
  const control = new CommanderControlServer({ gateway, socketPath });
  await control.start();
  t.after(async () => {
    await control.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('src/integrations/mcp/commander/stdio.mjs')],
    env: {
      ...process.env,
      COMMANDER_CONTROL_SOCKET: socketPath,
      COMMANDER_MCP_DEVICE_ID: 'device-a',
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'commander-stdio-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'modern' } },
  );
  t.after(async () => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ['commander_v1_device_health']);
  const result = await client.callTool({ name: 'commander_v1_device_health', arguments: { params: {} } });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.operation, 'device.health');
});
