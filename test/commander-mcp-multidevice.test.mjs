import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { operationDefinition, protocolEnvelope } from '../src/commander/contracts/index.mjs';
import { buildCommanderMcpServer } from '../src/integrations/mcp/commander/server.mjs';
import { CommanderRemoteMcpHttpServer } from '../src/integrations/mcp/commander/remote-http.mjs';
import { commanderRemoteMcpBearerVerifier } from '../src/integrations/mcp/commander/remote-auth.mjs';

const now = '2026-09-17T19:00:00Z';
const token = 'multi-device-test-token-0123456789abcdef0123456789abcdef';

function capability(operation) {
  const definition = operationDefinition(operation);
  return { operation, authority: definition.authority, operationVersion: definition.operationVersion };
}

function entry(deviceId, displayName, capabilities, status = 'online') {
  return {
    status, connectedAt: now, lastHeartbeatAt: now,
    device: { ...protocolEnvelope(), deviceId, displayName, platform: 'linux', agentVersion: '0.1.0',
      sessionId: `session-${deviceId}`, connectedAt: now, capabilities },
  };
}
function okResult(request) {
  return { ...protocolEnvelope(), requestId: request.requestId, deviceId: request.deviceId,
    operation: request.operation, ok: true, completedAt: now, data: { selected: request.deviceId } };
}

async function connectInMemory(t, clientBackend, entries) {
  const server = buildCommanderMcpServer({ client: clientBackend, deviceEntries: entries, multiDevice: true });
  const client = new Client({ name: 'multi-test', version: '1.0.0' }, { versionNegotiation: { mode: 'modern' } });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('multi-device MCP lists devices and routes one typed tool to the selected device', async (t) => {
  const entries = [
    entry('btc-radar', 'BTC Radar', [capability('device.health'), capability('execution.start')]),
    entry('nexolab-edge-01', 'NEXOLAB', [capability('device.health'), capability('file.read')]),
  ];
  const requests = [];
  const backend = {
    listDevices: async () => ({ devices: entries }),
    getDevice: async (id) => entries.find((row) => row.device.deviceId === id) ?? null,
    request: async (request) => { requests.push(request); return okResult(request); },
  };
  const client = await connectInMemory(t, backend, entries);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some((tool) => tool.name === 'commander_v1_device_list'));
  assert.ok(tools.some((tool) => tool.name === 'commander_v1_file_read'));
  assert.ok(tools.some((tool) => tool.name === 'commander_v1_execution_start'));
  const deviceList = await client.callTool({ name: 'commander_v1_device_list', arguments: {} });
  assert.deepEqual(deviceList.structuredContent.devices.map((row) => row.deviceId), ['btc-radar', 'nexolab-edge-01']);
  assert.equal(deviceList.structuredContent.devices[0].capabilities.includes('system.reboot'), false);

  const readTool = tools.find((tool) => tool.name === 'commander_v1_file_read');
  assert.equal(readTool.inputSchema.required.includes('deviceId'), true);
  const read = await client.callTool({
    name: 'commander_v1_file_read',
    arguments: { deviceId: 'nexolab-edge-01', params: { path: '/tmp/x' } },
  });
  assert.equal(read.structuredContent.ok, true);
  assert.equal(requests.at(-1).deviceId, 'nexolab-edge-01');
  assert.equal(requests.at(-1).operation, 'file.read');

  const start = await client.callTool({
    name: 'commander_v1_execution_start',
    arguments: { deviceId: 'btc-radar', params: { alias: 'operator.shell' }, idempotencyKey: 'shell-start-1' },
  });
  assert.equal(start.structuredContent.ok, true);
  assert.equal(requests.at(-1).deviceId, 'btc-radar');
});

test('multi-device MCP fails closed when selected device lacks a previously advertised capability', async (t) => {
  let entries = [
    entry('device-a', 'A', [capability('device.health'), capability('file.read')]),
    entry('device-b', 'B', [capability('device.health')]),
  ];
  const requests = [];
  const backend = {
    listDevices: async () => ({ devices: entries }),
    getDevice: async (id) => entries.find((row) => row.device.deviceId === id) ?? null,
    request: async (request) => { requests.push(request); return okResult(request); },
  };
  const client = await connectInMemory(t, backend, entries);
  const result = await client.callTool({
    name: 'commander_v1_file_read', arguments: { deviceId: 'device-b', params: { path: '/tmp/x' } },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'OPERATION_NOT_ADVERTISED');
  assert.equal(requests.length, 0);
});
test('remote HTTP multi-device mode authenticates one MCP endpoint for multiple devices', async (t) => {
  const entries = [
    entry('btc-radar', 'BTC Radar', [capability('device.health')]),
    entry('nexolab-edge-01', 'NEXOLAB', [capability('device.health'), capability('process.list')]),
  ];
  const requests = [];
  const backend = {
    listDevices: async () => ({ devices: entries }),
    getDevice: async (id) => entries.find((row) => row.device.deviceId === id) ?? null,
    request: async (request) => { requests.push(request); return okResult(request); },
  };
  const server = new CommanderRemoteMcpHttpServer({
    host: '127.0.0.1', port: 0, multiDevice: true, client: backend,
    verifyAuthorization: commanderRemoteMcpBearerVerifier(token), logger: { info() {}, warn() {}, error() {} },
  });
  const address = await server.start();
  t.after(() => server.stop());
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'remote-multi-test', version: '1.0.0' }, { versionNegotiation: { mode: 'modern' } });
  await client.connect(transport);
  t.after(() => client.close());

  const devices = await client.callTool({ name: 'commander_v1_device_list', arguments: {} });
  assert.equal(devices.structuredContent.devices.length, 2);
  const health = await client.callTool({
    name: 'commander_v1_device_health', arguments: { deviceId: 'btc-radar', params: {} },
  });
  assert.equal(health.structuredContent.ok, true);
  assert.equal(requests.at(-1).deviceId, 'btc-radar');
});
