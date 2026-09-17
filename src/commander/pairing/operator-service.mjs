import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commanderEnabled, commanderPort, resolveCommanderGatewayBindHost } from '../config.mjs';
import { CommanderTrustStore } from '../gateway/trust-store.mjs';
import { CommanderPairingService } from './service.mjs';
import { CommanderOidcClient } from './oidc.mjs';
import { CommanderPairingOperatorServer } from './operator-server.mjs';

export async function runPairingOperatorService(env = process.env) {
  if (!commanderEnabled(env.COMMANDER_PAIRING_OPERATOR_ENABLED)) {
    console.info(JSON.stringify({ event: 'commander_pairing_operator_disabled' }));
    return null;
  }
  const home = env.HOME || os.homedir();
  const publicBaseUrl = env.COMMANDER_PAIRING_PUBLIC_BASE_URL;
  if (!publicBaseUrl) throw new Error('COMMANDER_PAIRING_PUBLIC_BASE_URL_required');
  const stateDir = path.join(home, '.local/state/chatgpt-autopilot-commander');
  const trustStoreFile = env.COMMANDER_GATEWAY_TRUST_STORE || path.join(stateDir, 'gateway-trust.json');
  const pairingStateFile = env.COMMANDER_PAIRING_STATE_FILE || path.join(stateDir, 'pairing-requests.json');
  const trustStore = new CommanderTrustStore({ filePath: trustStoreFile });
  await trustStore.load();
  const pairingService = new CommanderPairingService({
    stateFile: pairingStateFile,
    trustStore,
    verificationUri: `${String(publicBaseUrl).replace(/\/$/, '')}/device`,
  });
  await pairingService.load();

  let oidcClient = null;
  if (env.COMMANDER_OIDC_ISSUER || env.COMMANDER_OIDC_CLIENT_ID) {
    if (!env.COMMANDER_OIDC_ISSUER || !env.COMMANDER_OIDC_CLIENT_ID) throw new Error('commander_oidc_configuration_incomplete');
    oidcClient = new CommanderOidcClient({
      issuer: env.COMMANDER_OIDC_ISSUER,
      clientId: env.COMMANDER_OIDC_CLIENT_ID,
      clientSecret: env.COMMANDER_OIDC_CLIENT_SECRET || '',
      redirectUri: env.COMMANDER_OIDC_REDIRECT_URI || `${String(publicBaseUrl).replace(/\/$/, '')}/auth/callback`,
      providerId: env.COMMANDER_OIDC_PROVIDER_ID || 'google',
    });
  }

  const privateBindEnabled = commanderEnabled(env.COMMANDER_PAIRING_PRIVATE_BIND_ENABLED);
  const host = resolveCommanderGatewayBindHost(env.COMMANDER_PAIRING_HOST || '127.0.0.1', {
    privateBindEnabled, networkInterfaces: os.networkInterfaces(),
  });
  const server = new CommanderPairingOperatorServer({
    host,
    port: commanderPort(env.COMMANDER_PAIRING_PORT, 8791),
    publicBaseUrl,
    pairingService,
    trustStore,
    oidcClient,
  });
  await server.start();
  server.trustStore = trustStore;
  server.pairingService = pairingService;
  console.info(JSON.stringify({ event: 'commander_pairing_operator_started', address: server.server.address(), publicBaseUrl }));
  return server;
}

async function main() {
  const server = await runPairingOperatorService();
  if (!server) return;
  const stop = async () => { await server.stop(); process.exitCode = 0; };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'commander_pairing_operator_fatal', error: String(error.message || error) }));
    process.exitCode = 1;
  });
}
