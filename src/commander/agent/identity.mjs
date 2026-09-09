import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validate(value) {
  if (!value || value.version !== 1 || typeof value.deviceId !== 'string' || !DEVICE_ID.test(value.deviceId)) {
    throw new Error('invalid_commander_device_identity');
  }
  return value;
}

export async function loadOrCreateDeviceIdentity(filePath, { configuredDeviceId, randomUUID = crypto.randomUUID } = {}) {
  if (!path.isAbsolute(filePath)) throw new Error('identity_path_must_be_absolute');
  try {
    const existing = validate(JSON.parse(await fs.readFile(filePath, 'utf8')));
    if (configuredDeviceId && existing.deviceId !== configuredDeviceId) throw new Error('configured_device_id_mismatch');
    return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const deviceId = configuredDeviceId || `cmdr-${randomUUID()}`;
  validate({ version: 1, deviceId });
  const value = { version: 1, deviceId, createdAt: new Date().toISOString() };
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, filePath);
  await fs.chmod(filePath, 0o600);
  return value;
}
