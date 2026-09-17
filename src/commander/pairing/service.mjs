import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { devicePublicKeyFingerprint } from '../agent/device-keypair.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[A-HJ-NP-Z2-9]{8}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function hash(value) { return crypto.createHash('sha256').update(value).digest('base64url'); }
function safeEqualHash(a, b) {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function userCode(randomBytes) {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
function normalizeScopes(value = []) {
  if (!Array.isArray(value) || value.length > 64) throw new Error('invalid_pairing_scopes');
  const out = []; const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.length < 1 || raw.length > 160 || /[\0\r\n]/.test(raw)) throw new Error('invalid_pairing_scopes');
    if (!seen.has(raw)) { seen.add(raw); out.push(raw); }
  }
  return out;
}

function normalizeOperator(operator) {
  if (!operator || typeof operator !== 'object' || Array.isArray(operator)) throw new Error('invalid_pairing_operator');
  if (typeof operator.provider !== 'string' || operator.provider.length < 1 || operator.provider.length > 64) throw new Error('invalid_pairing_operator');
  if (typeof operator.subject !== 'string' || operator.subject.length < 1 || operator.subject.length > 512) throw new Error('invalid_pairing_operator');
  if (operator.email !== undefined && (typeof operator.email !== 'string' || operator.email.length > 320)) throw new Error('invalid_pairing_operator');
  return { provider: operator.provider, subject: operator.subject, ...(operator.email ? { email: operator.email } : {}) };
}

export class CommanderPairingService {
  constructor({ stateFile, trustStore, verificationUri, ttlMs = 10 * 60 * 1000, now = Date.now, randomBytes = crypto.randomBytes, rateWindowMs = 60_000, maxCreatesPerWindow = 5, maxOperatorAttemptsPerWindow = 20, maxStatusPerWindow = 120 } = {}) {
    if (!path.isAbsolute(String(stateFile || ''))) throw new Error('pairing_state_path_must_be_absolute');
    if (!trustStore || typeof trustStore.trustDevice !== 'function') throw new Error('pairing_trust_store_required');
    let parsed;
    try { parsed = new URL(verificationUri); } catch { throw new Error('invalid_pairing_verification_uri'); }
    if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('pairing_verification_uri_must_be_https');
    if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * 60 * 1000) throw new Error('invalid_pairing_ttl');
    this.stateFile = stateFile; this.trustStore = trustStore; this.verificationUri = parsed.toString();
    this.ttlMs = ttlMs; this.now = now; this.randomBytes = randomBytes;
    this.rateWindowMs = rateWindowMs; this.maxCreatesPerWindow = maxCreatesPerWindow;
    this.maxOperatorAttemptsPerWindow = maxOperatorAttemptsPerWindow; this.maxStatusPerWindow = maxStatusPerWindow;
    for (const [name, value] of Object.entries({ rateWindowMs, maxCreatesPerWindow, maxOperatorAttemptsPerWindow, maxStatusPerWindow })) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`invalid_pairing_${name}`);
    }
    this.rate = new Map();
    this.state = { version: 1, requests: {} }; this.loaded = false; this.persistQueue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    const parent = path.dirname(this.stateFile);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 }); await fs.chmod(parent, 0o700);
    try {
      const stat = await fs.lstat(this.stateFile);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('invalid_pairing_state_file');
      if ((stat.mode & 0o077) !== 0) throw new Error('pairing_state_permissions_too_open');
      const parsed = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      if (!parsed || parsed.version !== 1 || !parsed.requests || typeof parsed.requests !== 'object' || Array.isArray(parsed.requests)) throw new Error('invalid_pairing_state');
      this.state = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.#persist();
    }
    this.loaded = true; await this.expire(); return this;
  }

  async createRequest({ deviceId, publicKeyPem, displayName = '', scopes = [] } = {}) {
    await this.load();
    if (typeof deviceId !== 'string' || !ID.test(deviceId)) throw new Error('invalid_pairing_device_id');
    this.#rateLimit(`create:${deviceId}`, this.maxCreatesPerWindow);
    if (typeof displayName !== 'string' || displayName.length > 120 || /[\0\r\n]/.test(displayName)) throw new Error('invalid_pairing_display_name');
    const fingerprint = devicePublicKeyFingerprint(publicKeyPem);
    const requestedScopes = normalizeScopes(scopes);
    const requestId = `pair-${this.randomBytes(16).toString('hex')}`;
    const deviceCode = this.randomBytes(32).toString('base64url');
    let code;
    do { code = userCode(this.randomBytes); } while (this.#findByCode(code));
    const issuedAt = this.now();
    this.state.requests[requestId] = {
      version: 1, requestId, deviceId, displayName, publicKeyPem, fingerprint, requestedScopes,
      userCodeHash: hash(code), deviceCodeHash: hash(deviceCode), status: 'pending',
      issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(issuedAt + this.ttlMs).toISOString(),
    };
    await this.#persist();
    return { requestId, deviceCode, userCode: code, verificationUri: this.verificationUri, expiresAt: this.state.requests[requestId].expiresAt };
  }

  async approve({ userCode: code, operator } = {}) {
    await this.load(); await this.expire();
    if (typeof code !== 'string' || !CODE.test(code)) throw new Error('invalid_pairing_user_code');
    this.#rateLimit('operator:global', this.maxOperatorAttemptsPerWindow);
    this.#rateLimit(`operator:${hash(code)}`, this.maxOperatorAttemptsPerWindow);
    const request = this.#findByCode(code);
    if (!request || request.status !== 'pending') throw new Error('pairing_request_not_pending');
    const normalizedOperator = normalizeOperator(operator);
    const trust = await this.trustStore.trustDevice({ deviceId: request.deviceId, publicKeyPem: request.publicKeyPem, operator: normalizedOperator, scopes: request.requestedScopes || [] });
    request.status = 'approved'; request.approvedAt = new Date(this.now()).toISOString(); request.operator = normalizedOperator;
    await this.#persist();
    return { requestId: request.requestId, deviceId: request.deviceId, fingerprint: request.fingerprint, status: request.status, approvedScopes: request.requestedScopes || [], trust };
  }

  async reject({ userCode: code, operator } = {}) {
    await this.load(); await this.expire();
    if (typeof code !== 'string' || !CODE.test(code)) throw new Error('invalid_pairing_user_code');
    this.#rateLimit('operator:global', this.maxOperatorAttemptsPerWindow);
    this.#rateLimit(`operator:${hash(code)}`, this.maxOperatorAttemptsPerWindow);
    const request = this.#findByCode(code);
    if (!request || request.status !== 'pending') throw new Error('pairing_request_not_pending');
    request.status = 'rejected'; request.rejectedAt = new Date(this.now()).toISOString(); request.operator = normalizeOperator(operator);
    await this.#persist();
    return { requestId: request.requestId, deviceId: request.deviceId, status: request.status };
  }

  async status({ requestId, deviceCode } = {}) {
    await this.load(); await this.expire();
    if (typeof requestId !== 'string' || !ID.test(requestId) || typeof deviceCode !== 'string' || deviceCode.length < 32 || deviceCode.length > 256) throw new Error('invalid_pairing_status_request');
    this.#rateLimit(`status:${requestId}`, this.maxStatusPerWindow);
    const request = this.state.requests[requestId];
    if (!request || !safeEqualHash(request.deviceCodeHash, hash(deviceCode))) throw new Error('pairing_status_not_authorized');
    return { requestId, deviceId: request.deviceId, fingerprint: request.fingerprint, status: request.status, expiresAt: request.expiresAt };
  }

  async inspect({ userCode: code } = {}) {
    await this.load(); await this.expire();
    if (typeof code !== 'string' || !CODE.test(code)) throw new Error('invalid_pairing_user_code');
    this.#rateLimit('operator:global', this.maxOperatorAttemptsPerWindow);
    this.#rateLimit(`operator:${hash(code)}`, this.maxOperatorAttemptsPerWindow);
    const request = this.#findByCode(code);
    if (!request || request.status !== 'pending') throw new Error('pairing_request_not_pending');
    return {
      requestId: request.requestId, deviceId: request.deviceId, displayName: request.displayName,
      fingerprint: request.fingerprint, scopes: request.requestedScopes || [], status: request.status, issuedAt: request.issuedAt, expiresAt: request.expiresAt,
    };
  }

  async expire() {
    let changed = false; const now = this.now();
    for (const request of Object.values(this.state.requests)) {
      if (request.status === 'pending' && Date.parse(request.expiresAt) <= now) { request.status = 'expired'; request.expiredAt = new Date(now).toISOString(); changed = true; }
    }
    if (changed) await this.#persist();
  }

  #rateLimit(key, limit) {
    const now = this.now();
    const cutoff = now - this.rateWindowMs;
    const prior = (this.rate.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (prior.length >= limit) throw new Error('pairing_rate_limited');
    prior.push(now);
    this.rate.set(key, prior);
    if (this.rate.size > 512) {
      for (const [entryKey, timestamps] of this.rate) {
        if (!timestamps.some((timestamp) => timestamp > cutoff)) this.rate.delete(entryKey);
      }
    }
  }

  #findByCode(code) {
    const wanted = hash(code);
    return Object.values(this.state.requests).find((request) => safeEqualHash(request.userCodeHash, wanted)) || null;
  }

  #persist() {
    const task = this.persistQueue.then(async () => {
      const parent = path.dirname(this.stateFile);
      await fs.mkdir(parent, { recursive: true, mode: 0o700 }); await fs.chmod(parent, 0o700);
      const encoded = `${JSON.stringify(this.state)}\n`;
      if (Buffer.byteLength(encoded) > 512 * 1024) throw new Error('pairing_state_too_large');
      const temp = `${this.stateFile}.${process.pid}.tmp`;
      try { await fs.writeFile(temp, encoded, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, this.stateFile); await fs.chmod(this.stateFile, 0o600); }
      catch (error) { await fs.rm(temp, { force: true }).catch(() => {}); throw error; }
    });
    this.persistQueue = task.catch(() => {}); return task;
  }
}
