import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateDeviceIdentity } from '../agent/identity.mjs';
import { loadOrCreateDeviceKeypair } from '../agent/device-keypair.mjs';
import { CommanderPairingDeviceClient } from './device-client.mjs';

function scopesFromEnv(value = '') {
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

export async function runCommanderPairingRegistration(env = process.env, { logger = console, fetchImpl = fetch } = {}) {
  const baseUrl = env.COMMANDER_PAIRING_BASE_URL;
  if (!baseUrl) throw new Error('COMMANDER_PAIRING_BASE_URL_required');
  const home = env.HOME || os.homedir();
  const identity = await loadOrCreateDeviceIdentity(env.COMMANDER_DEVICE_IDENTITY_FILE || path.join(home, '.local/state/chatgpt-autopilot-commander/device.json'), {
    configuredDeviceId: env.COMMANDER_DEVICE_ID,
  });
  const keypair = await loadOrCreateDeviceKeypair(env.COMMANDER_DEVICE_KEYPAIR_FILE || path.join(home, '.local/state/chatgpt-autopilot-commander/device-keypair.json'));
  const client = new CommanderPairingDeviceClient({ baseUrl, fetchImpl });
  const created = await client.create({
    deviceId: identity.deviceId,
    publicKeyPem: keypair.publicKeyPem,
    displayName: env.COMMANDER_DEVICE_NAME || os.hostname(),
    scopes: scopesFromEnv(env.COMMANDER_PAIRING_SCOPES),
  });
  logger.info(`Open: ${created.verificationUri}`);
  logger.info(`Code: ${created.userCode}`);
  logger.info(`Device: ${identity.deviceId}`);
  logger.info('Waiting for approval...');
  const decision = await client.waitForDecision(created);
  if (decision.status !== 'approved') throw new Error(`pairing_${decision.status}`);
  logger.info('Commander device pairing approved.');
  return { ...decision, fingerprint: keypair.fingerprint };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCommanderPairingRegistration().catch((error) => {
    console.error(`Commander pairing failed: ${String(error.message || error)}`);
    process.exitCode = 1;
  });
}
