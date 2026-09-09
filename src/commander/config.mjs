import fs from 'node:fs/promises';
import path from 'node:path';

export function commanderEnabled(value = process.env.COMMANDER_ENABLED) {
  return String(value ?? '').toLowerCase() === 'true';
}

export function commanderPort(value, fallback = 8790) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_commander_port');
  return port;
}

export function assertPhase2GatewayHost(host) {
  const value = String(host || '127.0.0.1');
  if (!['127.0.0.1', '::1', 'localhost'].includes(value)) throw new Error('phase2_gateway_must_be_loopback');
  return value;
}

export async function loadCommanderSecret(filePath) {
  if (!path.isAbsolute(String(filePath || ''))) throw new Error('secret_file_must_be_absolute');
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('secret_path_not_file');
  if ((stat.mode & 0o077) !== 0) throw new Error('secret_file_permissions_too_open');
  const secret = (await fs.readFile(filePath, 'utf8')).trim();
  const bytes = Buffer.byteLength(secret);
  if (bytes < 32 || bytes > 4096) throw new Error('invalid_agent_secret');
  return secret;
}

export async function loadGatewaySecretMap(filePath) {
  if (!path.isAbsolute(String(filePath || ''))) throw new Error('secret_map_must_be_absolute');
  const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (!data || data.version !== 1 || !data.devices || typeof data.devices !== 'object' || Array.isArray(data.devices)) {
    throw new Error('invalid_gateway_secret_map');
  }
  const devices = new Map();
  for (const [deviceId, secretFile] of Object.entries(data.devices)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId) || !path.isAbsolute(String(secretFile || ''))) {
      throw new Error('invalid_gateway_secret_mapping');
    }
    devices.set(deviceId, secretFile);
  }
  return async (deviceId) => {
    const secretFile = devices.get(deviceId);
    if (!secretFile) return null;
    return loadCommanderSecret(secretFile);
  };
}
