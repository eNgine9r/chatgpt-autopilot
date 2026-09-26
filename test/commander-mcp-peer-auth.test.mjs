import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { operationDefinition, protocolEnvelope } from '../src/commander/contracts/index.mjs';
import { CommanderRemoteMcpHttpServer } from '../src/integrations/mcp/commander/remote-http.mjs';
import { commanderRemoteMcpTailscalePeerVerifier } from '../src/integrations/mcp/commander/remote-auth.mjs';

const now = '2026-09-26T09:00:00Z';
const silent = { info() {}, warn() {}, error() {} };

function capability(operation) {
  const definition = operationDefinition(operation);
  return { operation, authority: definition.authority, operationVersion: definition.operationVersion };
}

function entry(capabilities) {
  return {
    status: 'online', connectedAt: now, lastHeartbeatAt: now,
    device: {
      ...protocolEnvelope(), deviceId: 'device-peer', displayName: 'Peer Device', platform: 'linux',
      agentVersion: '0.1.0', sessionId: 'session-peer', connectedAt: now, capabilities,
    },
  };
}

test('Tailscale peer verifier accepts only the configured CGNAT peer', () => {
  const verify = commanderRemoteMcpTailscalePeerVerifier('100.82.131.86');
  assert.equal(verify('100.82.131.86'), true);
  assert.equal(verify('::ffff:100.82.131.86'), true);
  assert.equal(verify('100.72.160.97'), false);
  assert.equal(verify('192.168.1.20'), false);
  assert.throws(() => commanderRemoteMcpTailscalePeerVerifier('100.63.1.2'), /invalid_remote_mcp_tailscale_peer_ip/);
  assert.throws(() => commanderRemoteMcpTailscalePeerVerifier('192.168.1.20'), /invalid_remote_mcp_tailscale_peer_ip/);
});

test('Remote MCP can authorize an explicitly verified peer without bearer reuse', async (t) => {
  const publicClient = {
    getDevice: async () => entry([capability('device.health')]),
    request: async (request) => ({
      ...protocolEnvelope(), requestId: request.requestId, deviceId: request.deviceId, operation: request.operation,
      ok: true, completedAt: now, data: { accepted: true },
    }),
  };
  const server = new CommanderRemoteMcpHttpServer({
    host: '127.0.0.1',
    port: 0,
    deviceId: 'device-peer',
    client: publicClient,
    verifyAuthorization: () => false,
    verifyPeer: (remoteAddress) => remoteAddress === '127.0.0.1' || remoteAddress === '::ffff:127.0.0.1',
    logger: silent,
  });
  const address = await server.start();
  t.after(() => server.stop());

  const client = new Client(
    { name: 'peer-auth-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'modern' } },
  );
  t.after(() => client.close());
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(tools, ['commander_v1_device_health']);
});
