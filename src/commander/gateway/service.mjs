import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPhase2GatewayHost, commanderEnabled, commanderPort, loadGatewaySecretMap } from '../config.mjs';
import { CommanderGatewayServer } from './server.mjs';

export async function runGatewayService(env = process.env) {
  if (!commanderEnabled(env.COMMANDER_ENABLED)) {
    console.info(JSON.stringify({ event: 'commander_gateway_disabled' }));
    return null;
  }
  const home = env.HOME || os.homedir();
  const secretMap = env.COMMANDER_GATEWAY_SECRET_MAP
    || path.join(home, '.config/chatgpt-autopilot-commander/gateway-secrets.json');
  const secretResolver = await loadGatewaySecretMap(secretMap);
  const server = new CommanderGatewayServer({
    host: assertPhase2GatewayHost(env.COMMANDER_GATEWAY_HOST || '127.0.0.1'),
    port: commanderPort(env.COMMANDER_GATEWAY_PORT),
    secretResolver,
  });
  await server.start();
  console.info(JSON.stringify({ event: 'commander_gateway_started', address: server.address() }));
  return server;
}

async function main() {
  const server = await runGatewayService();
  if (!server) return;
  const stop = async () => { await server.stop(); process.exitCode = 0; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'commander_gateway_fatal', error: String(error.message || error) }));
    process.exitCode = 1;
  });
}
