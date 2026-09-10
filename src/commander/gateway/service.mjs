import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPhase2GatewayHost,
  commanderControlSocketPath,
  commanderEnabled,
  commanderPort,
  loadGatewaySecretMap,
} from '../config.mjs';
import { CommanderControlServer } from './control-server.mjs';
import { CommanderGatewayServer } from './server.mjs';

export async function runGatewayService(env = process.env) {
  if (!commanderEnabled(env.COMMANDER_ENABLED)) {
    console.info(JSON.stringify({ event: 'commander_gateway_disabled' }));
    return null;
  }
  if (commanderEnabled(env.COMMANDER_ADMIN_ENABLED)) throw new Error('commander_admin_not_supported_phase6');
  const home = env.HOME || os.homedir();
  const secretMap = env.COMMANDER_GATEWAY_SECRET_MAP
    || path.join(home, '.config/chatgpt-autopilot-commander/gateway-secrets.json');
  const secretResolver = await loadGatewaySecretMap(secretMap);
  const server = new CommanderGatewayServer({
    host: assertPhase2GatewayHost(env.COMMANDER_GATEWAY_HOST || '127.0.0.1'),
    port: commanderPort(env.COMMANDER_GATEWAY_PORT),
    secretResolver,
    allowedAuthorities: (commanderEnabled(env.COMMANDER_EXECUTION_ENABLED) || commanderEnabled(env.COMMANDER_WRITE_ENABLED)) ? ['read', 'write'] : ['read'],
  });
  await server.start();

  const controlServer = new CommanderControlServer({
    gateway: server,
    socketPath: commanderControlSocketPath(env),
  });
  try {
    await controlServer.start();
  } catch (error) {
    await server.stop();
    throw error;
  }

  const stopGateway = server.stop.bind(server);
  let stopped = false;
  server.stop = async () => {
    if (stopped) return;
    stopped = true;
    await controlServer.stop();
    await stopGateway();
  };
  server.controlServer = controlServer;
  console.info(JSON.stringify({ event: 'commander_gateway_started', address: server.address(), controlSocket: controlServer.socketPath }));
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
