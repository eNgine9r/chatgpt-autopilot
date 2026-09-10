import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { CommanderPublicClient } from '../../../commander/client/index.mjs';
import { commanderControlSocketPath } from '../../../commander/config.mjs';
import { buildCommanderMcpServer } from './server.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export async function runCommanderMcpStdio(env = process.env) {
  const deviceId = String(env.COMMANDER_MCP_DEVICE_ID || '');
  if (!ID.test(deviceId)) throw new Error('COMMANDER_MCP_DEVICE_ID_required');
  const client = new CommanderPublicClient({ socketPath: commanderControlSocketPath(env) });
  const deviceEntry = await client.getDevice(deviceId);
  if (deviceEntry.status !== 'online') throw new Error('commander_mcp_device_offline');

  await serveStdio(
    () => buildCommanderMcpServer({ client, deviceId, deviceEntry }),
    { legacy: 'reject' },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCommanderMcpStdio().catch((error) => {
    // stdout is reserved exclusively for MCP protocol frames.
    console.error(JSON.stringify({ event: 'commander_mcp_fatal', error: String(error?.message || error) }));
    process.exitCode = 1;
  });
}
