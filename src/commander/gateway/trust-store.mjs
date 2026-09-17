import fs from 'node:fs/promises';
import path from 'node:path';
import { devicePublicKeyFingerprint } from '../agent/device-keypair.mjs';

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function validateScopes(value = []) {
  if (!Array.isArray(value) || value.length > 64) throw new Error('invalid_pairing_scopes');
  const seen = new Set(); const scopes = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.length < 1 || raw.length > 160 || /[\0\r\n]/.test(raw)) throw new Error('invalid_pairing_scopes');
    if (!seen.has(raw)) { seen.add(raw); scopes.push(raw); }
  }
  return scopes;
}

function validateOperator(operator) {
  if (!operator || typeof operator !== 'object' || Array.isArray(operator)) throw new Error('invalid_pairing_operator');
  if (typeof operator.provider !== 'string' || !PROVIDER.test(operator.provider)) throw new Error('invalid_pairing_operator_provider');
  if (typeof operator.subject !== 'string' || operator.subject.length < 1 || operator.subject.length > 512) throw new Error('invalid_pairing_operator_subject');
  if (operator.email !== undefined && (typeof operator.email !== 'string' || operator.email.length > 320 || /[\0\r\n]/.test(operator.email))) throw new Error('invalid_pairing_operator_email');
  return { provider: operator.provider, subject: operator.subject, ...(operator.email ? { email: operator.email } : {}) };
}

export class CommanderTrustStore {
  constructor({ filePath, now = Date.now } = {}) {
    if (!path.isAbsolute(String(filePath || ''))) throw new Error('trust_store_path_must_be_absolute');
    this.filePath = filePath;
    this.now = now;
    this.state = { version: 1, devices: {} };
    this.loaded = false;
    this.persistQueue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    const parent = path.dirname(this.filePath);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await fs.chmod(parent, 0o700);
    try {
      const stat = await fs.lstat(this.filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('invalid_trust_store_file');
      if ((stat.mode & 0o077) !== 0) throw new Error('trust_store_permissions_too_open');
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (!parsed || parsed.version !== 1 || !parsed.devices || typeof parsed.devices !== 'object' || Array.isArray(parsed.devices)) throw new Error('invalid_trust_store');
      this.state = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.#persist();
    }
    this.loaded = true;
    return this;
  }

  async trustDevice({ deviceId, publicKeyPem, operator, scopes = [] }) {
    await this.load();
    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) throw new Error('invalid_pairing_device_id');
    const fingerprint = devicePublicKeyFingerprint(publicKeyPem);
    const existing = this.state.devices[deviceId];
    if (existing?.status === 'trusted' && existing.fingerprint !== fingerprint) throw new Error('device_key_rotation_requires_revocation');
    const timestamp = new Date(this.now()).toISOString();
    const record = {
      version: 1, deviceId, algorithm: 'Ed25519', publicKeyPem, fingerprint,
      status: 'trusted', operator: validateOperator(operator), approvedScopes: validateScopes(scopes), pairedAt: existing?.pairedAt || timestamp,
      updatedAt: timestamp,
    };
    this.state.devices[deviceId] = record;
    await this.#persist();
    return this.publicRecord(record);
  }

  async revokeDevice(deviceId, operator = null) {
    await this.load();
    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) throw new Error('invalid_pairing_device_id');
    const record = this.state.devices[deviceId];
    if (!record) return null;
    const timestamp = new Date(this.now()).toISOString();
    record.status = 'revoked';
    record.revokedAt = timestamp;
    record.updatedAt = timestamp;
    if (operator) record.revokedBy = validateOperator(operator);
    await this.#persist();
    return this.publicRecord(record);
  }

  async refresh() {
    await this.load();
    const stat = await fs.lstat(this.filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('invalid_trust_store_file');
    if ((stat.mode & 0o077) !== 0) throw new Error('trust_store_permissions_too_open');
    const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    if (!parsed || parsed.version !== 1 || !parsed.devices || typeof parsed.devices !== 'object' || Array.isArray(parsed.devices)) throw new Error('invalid_trust_store');
    this.state = parsed;
    return this;
  }

  async resolvePublicKey(deviceId) {
    await this.refresh();
    const record = this.state.devices[deviceId];
    return record?.status === 'trusted' ? record.publicKeyPem : null;
  }

  async get(deviceId) {
    await this.refresh();
    const record = this.state.devices[deviceId];
    return record ? this.publicRecord(record) : null;
  }

  async list() {
    await this.refresh();
    return Object.values(this.state.devices)
      .map((record) => this.publicRecord(record))
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  publicRecord(record) {
    return {
      version: record.version, deviceId: record.deviceId, algorithm: record.algorithm,
      fingerprint: record.fingerprint, status: record.status, operator: { ...record.operator }, approvedScopes: [...(record.approvedScopes || [])],
      pairedAt: record.pairedAt, updatedAt: record.updatedAt,
      ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
    };
  }

  #persist() {
    const task = this.persistQueue.then(async () => {
      const parent = path.dirname(this.filePath);
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      await fs.chmod(parent, 0o700);
      const encoded = `${JSON.stringify(this.state)}\n`;
      if (Buffer.byteLength(encoded) > 512 * 1024) throw new Error('trust_store_too_large');
      const temp = `${this.filePath}.${process.pid}.tmp`;
      try {
        await fs.writeFile(temp, encoded, { mode: 0o600, flag: 'wx' });
        await fs.rename(temp, this.filePath);
        await fs.chmod(this.filePath, 0o600);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
    });
    this.persistQueue = task.catch(() => {});
    return task;
  }
}
