import crypto from 'node:crypto';
import { COMMANDER_PROTOCOL, protocolEnvelope } from '../contracts/index.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
export const COMMANDER_CHALLENGE_TTL_MS = 30_000;

function assertId(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`invalid_${name}`);
}

function assertSecret(secret) {
  if (!(Buffer.isBuffer(secret) || typeof secret === 'string')) throw new Error('invalid_agent_secret');
  const bytes = Buffer.byteLength(secret);
  if (bytes < 32 || bytes > 4096) throw new Error('invalid_agent_secret');
}

function canonicalProof({ challengeId, nonce, deviceId, agentVersion }) {
  return [COMMANDER_PROTOCOL.name, COMMANDER_PROTOCOL.currentVersion, challengeId, nonce, deviceId, agentVersion].join('\n');
}

export function createChallenge({ now = Date.now, randomBytes = crypto.randomBytes } = {}) {
  return {
    ...protocolEnvelope(),
    type: 'challenge',
    challengeId: `challenge-${randomBytes(16).toString('hex')}`,
    nonce: randomBytes(32).toString('base64url'),
    issuedAt: new Date(now()).toISOString(),
  };
}

export function createRegistrationProof(secret, challenge, device, options = {}) {
  assertSecret(secret);
  validateChallenge(challenge, options);
  assertId(device?.deviceId, 'device_id');
  if (typeof device?.agentVersion !== 'string') throw new Error('invalid_agent_version');
  return crypto.createHmac('sha256', secret)
    .update(canonicalProof({ ...challenge, deviceId: device.deviceId, agentVersion: device.agentVersion }))
    .digest('base64url');
}

export function validateChallenge(challenge, { now = Date.now, ttlMs = COMMANDER_CHALLENGE_TTL_MS } = {}) {
  if (!challenge || challenge.protocol !== 'commander' || challenge.protocolVersion !== 1 || challenge.minProtocolVersion !== 1) {
    throw new Error('invalid_challenge_protocol');
  }
  if (challenge.type !== 'challenge') throw new Error('invalid_challenge_type');
  assertId(challenge.challengeId, 'challenge_id');
  if (typeof challenge.nonce !== 'string' || !NONCE.test(challenge.nonce)) throw new Error('invalid_challenge_nonce');
  const issued = Date.parse(challenge.issuedAt);
  if (!Number.isFinite(issued)) throw new Error('invalid_challenge_time');
  const age = now() - issued;
  if (age < -5_000 || age > ttlMs) throw new Error('expired_challenge');
  return challenge;
}

export function verifyRegistrationProof(secret, challenge, device, proof, options = {}) {
  validateChallenge(challenge, options);
  const expected = createRegistrationProof(secret, challenge, device, options);
  if (typeof proof !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(proof);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
