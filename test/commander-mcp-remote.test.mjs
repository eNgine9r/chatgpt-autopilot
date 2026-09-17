import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { operationDefinition, protocolEnvelope } from '../src/commander/contracts/index.mjs';
import { CommanderRemoteMcpHttpServer } from '../src/integrations/mcp/commander/remote-http.mjs';
import {
  commanderRemoteMcpBearerVerifier,
  loadCommanderRemoteMcpBearerToken,
} from '../src/integrations/mcp/commander/remote-auth.mjs';
import {
  resolveCommanderRemoteMcpBindHost,
  runCommanderRemoteMcpService,
} from '../src/integrations/mcp/commander/remote-service.mjs';

const now = '2026-09-17T11:00:00Z';
const token = 'remote-mcp-test-token-0123456789abcdef0123456789abcdef';
const silent = { info() {}, warn() {}, error() {} };

function capability(operation) {
  const definition = operationDefinition(operation);
  return { operation, authority: definition.authority, operationVersion: definition.operationVersion };
}

function entry(capabilities) {
  return {
    status: 'online', connectedAt: now, lastHeartbeatAt: now,
    device: {
      ...protocolEnvelope(), deviceId: 'device-a', displayName: 'Device A', platform: 'linux',
      agentVersion: '0.1.0', sessionId: 'session-a', connectedAt: now, capabilities,
    },
  };
}

function okResult(request) {
  return {
    ...protocolEnvelope(), requestId: request.requestId, deviceId: request.deviceId, operation: request.operation,
    ok: true, completedAt: now, data: { accepted: true, workSessionId: request.workSessionId || null },
  };
}

async function startFixture(t, initialCapabilities) {
  let current = entry(initialCapabilities);
  const requests = [];
  let getDeviceCalls = 0;
  const publicClient = {
    getDevice: async () => { getDeviceCalls += 1; return current; },
    request: async (request) => { requests.push(request); return okResult(request); },
  };
  const server = new CommanderRemoteMcpHttpServer({
    host: '127.0.0.1', port: 0, deviceId: 'device-a', client: publicClient,
    verifyAuthorization: commanderRemoteMcpBearerVerifier(token), logger: silent,
  });
  const address = await server.start();
  t.after(() => server.stop());
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  return {
    url, requests, publicClient,
    get getDeviceCalls() { return getDeviceCalls; },
    setCapabilities: (capabilities) => { current = entry(capabilities); },
  };
}

function authenticatedClient(url) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client(
    { name: 'commander-remote-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'modern' } },
  );
  return { client, transport };
}

test('remote MCP rejects unauthorized clients before device discovery', async (t) => {
  const fixture = await startFixture(t, [capability('device.health')]);
  const response = await fetch(fixture.url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') || '', /^Bearer /);
  assert.equal(fixture.getDeviceCalls, 0);
});

test('authenticated Streamable HTTP client lists and calls typed Commander tools', async (t) => {
  const fixture = await startFixture(t, [capability('device.health'), capability('work_session.resume'), capability('system.reboot')]);
  const { client, transport } = authenticatedClient(fixture.url);
  t.after(() => client.close());
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, ['commander_v1_device_health', 'commander_v1_work_session_resume']);
  const result = await client.callTool({ name: 'commander_v1_device_health', arguments: { params: {} } });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(fixture.requests.at(-1).operation, 'device.health');
});

test('persistent WorkSession can be resumed after remote MCP client reconnect', async (t) => {
  const fixture = await startFixture(t, [capability('work_session.resume'), capability('file.read')]);
  const first = authenticatedClient(fixture.url);
  await first.client.connect(first.transport);
  await first.client.close();

  const second = authenticatedClient(fixture.url);
  t.after(() => second.client.close());
  await second.client.connect(second.transport);
  const result = await second.client.callTool({
    name: 'commander_v1_work_session_resume',
    arguments: { params: { workSessionId: 'work-123' } },
  });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(fixture.requests.at(-1).operation, 'work_session.resume');
  assert.deepEqual(fixture.requests.at(-1).params, { workSessionId: 'work-123' });
});

test('live capability revocation prevents execution after prior discovery', async (t) => {
  const fixture = await startFixture(t, [capability('device.health'), capability('execution.start')]);
  const { client, transport } = authenticatedClient(fixture.url);
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'commander_v1_execution_start'));
  fixture.setCapabilities([capability('device.health')]);
  const before = fixture.requests.length;
  await assert.rejects(() => client.callTool({
    name: 'commander_v1_execution_start',
    arguments: { params: { alias: 'diagnostics' }, idempotencyKey: 'idem-remote-1' },
  }), /not found/i);
  assert.equal(fixture.requests.length, before);
});

test('remote mutating tools preserve idempotency requirements', async (t) => {
  const fixture = await startFixture(t, [capability('execution.start')]);
  const { client, transport } = authenticatedClient(fixture.url);
  t.after(() => client.close());
  await client.connect(transport);
  const tool = (await client.listTools()).tools.find((item) => item.name === 'commander_v1_execution_start');
  assert.equal(tool.inputSchema.required.includes('idempotencyKey'), true);
  const invalid = await client.callTool({ name: 'commander_v1_execution_start', arguments: { params: { alias: 'diagnostics' } } });
  assert.equal(invalid.isError, true);
  const valid = await client.callTool({
    name: 'commander_v1_execution_start',
    arguments: { params: { alias: 'diagnostics' }, idempotencyKey: 'idem-remote-2' },
  });
  assert.equal(valid.structuredContent.ok, true);
  assert.equal(fixture.requests.at(-1).idempotencyKey, 'idem-remote-2');
});

test('remote bearer token file is private and token comparison is constant-time compatible', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-remote-mcp-token-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'token');
  await fs.writeFile(file, `${token}\n`, { mode: 0o600 });
  assert.equal(await loadCommanderRemoteMcpBearerToken(file), token);
  const verify = commanderRemoteMcpBearerVerifier(token);
  assert.equal(verify(`Bearer ${token}`), true);
  assert.equal(verify('Bearer wrong'), false);
  await fs.chmod(file, 0o644);
  await assert.rejects(() => loadCommanderRemoteMcpBearerToken(file), /permissions_too_open/);
});

test('remote MCP bind is loopback by default and exact tailscale0 only behind opt-in gate', () => {
  const interfaces = {
    tailscale0: [{ address: '100.72.160.97', family: 'IPv4', internal: false }],
    eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
  };
  assert.equal(resolveCommanderRemoteMcpBindHost('127.0.0.1', { networkInterfaces: interfaces }), '127.0.0.1');
  assert.equal(resolveCommanderRemoteMcpBindHost('100.72.160.97', { privateBindEnabled: true, networkInterfaces: interfaces }), '100.72.160.97');
  assert.throws(() => resolveCommanderRemoteMcpBindHost('0.0.0.0', { privateBindEnabled: true, networkInterfaces: interfaces }), /wildcard_bind_forbidden/);
  assert.throws(() => resolveCommanderRemoteMcpBindHost('192.168.1.20', { privateBindEnabled: true, networkInterfaces: interfaces }), /not_tailscale0/);
  assert.throws(() => resolveCommanderRemoteMcpBindHost('100.72.160.97', { privateBindEnabled: false, networkInterfaces: interfaces }), /must_be_loopback/);
});

test('disabled remote MCP service exits before reading secrets or opening sockets', async () => {
  assert.equal(await runCommanderRemoteMcpService({ COMMANDER_REMOTE_MCP_ENABLED: 'false' }), null);
});
