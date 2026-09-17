import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { commanderEnabled, commanderPort, resolveCommanderGatewayBindHost } from '../../../commander/config.mjs';
import { commanderPublicClientFromEnv } from '../../../commander/client/index.mjs';
import { CommanderRemoteMcpHttpServer } from './remote-http.mjs';
import { commanderRemoteMcpBearerVerifier, loadCommanderRemoteMcpBearerToken } from './remote-auth.mjs';

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function resolveCommanderRemoteMcpBindHost(host, { privateBindEnabled = false, networkInterfaces = os.networkInterfaces() } = {}) {
  return resolveCommanderGatewayBindHost(host || '127.0.0.1', { privateBindEnabled, networkInterfaces });
}

export async function runCommanderRemoteMcpService(env = process.env) {
  if (!commanderEnabled(env.COMMANDER_REMOTE_MCP_ENABLED)) {
    console.info(JSON.stringify({ event: 'commander_remote_mcp_disabled' }));
    return null;
  }
  const multiDevice = commanderEnabled(env.COMMANDER_REMOTE_MCP_MULTI_DEVICE_ENABLED);
  const deviceId = String(env.COMMANDER_REMOTE_MCP_DEVICE_ID || '');
  if (!multiDevice && !DEVICE_ID.test(deviceId)) throw new Error('COMMANDER_REMOTE_MCP_DEVICE_ID_required');
  const tokenFile = env.COMMANDER_REMOTE_MCP_TOKEN_FILE;
  if (!tokenFile) throw new Error('COMMANDER_REMOTE_MCP_TOKEN_FILE_required');
  const token = await loadCommanderRemoteMcpBearerToken(tokenFile);
  const privateBindEnabled = commanderEnabled(env.COMMANDER_REMOTE_MCP_PRIVATE_BIND_ENABLED);
  const host = resolveCommanderRemoteMcpBindHost(env.COMMANDER_REMOTE_MCP_HOST || '127.0.0.1', { privateBindEnabled });
  const server = new CommanderRemoteMcpHttpServer({
    host,
    port: commanderPort(env.COMMANDER_REMOTE_MCP_PORT, 8792),
    deviceId: multiDevice ? undefined : deviceId,
    multiDevice,
    client: commanderPublicClientFromEnv(env),
    verifyAuthorization: commanderRemoteMcpBearerVerifier(token),
  });
  await server.start();
  console.info(JSON.stringify({ event: 'commander_remote_mcp_started', address: server.server.address(), deviceId: multiDevice ? 'multi' : deviceId }));
  return server;
}

async function main() {
  const server = await runCommanderRemoteMcpService();
  if (!server) return;
  const stop = async () => { await server.stop(); process.exitCode = 0; };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'commander_remote_mcp_fatal', error: String(error?.message || error) }));
    process.exitCode = 1;
  });
}
