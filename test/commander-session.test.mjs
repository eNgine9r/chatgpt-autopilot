import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COMMANDER_OPERATIONS,
  protocolEnvelope,
} from '../src/commander/contracts/index.mjs';
import { createChallenge, createRegistrationProof, validateChallenge, verifyRegistrationProof } from '../src/commander/session/auth.mjs';
import { encodeJsonLine, JsonLineDecoder } from '../src/commander/session/framing.mjs';
import { loadOrCreateDeviceIdentity } from '../src/commander/agent/identity.mjs';
import { CommanderDeviceRegistry } from '../src/commander/gateway/device-registry.mjs';
import { assertPhase2GatewayHost, commanderEnabled, commanderPort, loadCommanderSecret, loadGatewaySecretMap } from '../src/commander/config.mjs';

const secret = 's'.repeat(48);
const device = {
  ...protocolEnvelope(),
  deviceId: 'btc-radar', platform: 'linux', agentVersion: '0.1.0', capabilities: [],
};

test('challenge proof authenticates the stable device without sending the secret', () => {
  const now = () => Date.parse('2026-09-09T10:00:00Z');
  const randomBytes = (size) => Buffer.alloc(size, 7);
  const challenge = createChallenge({ now, randomBytes });
  const proof = createRegistrationProof(secret, challenge, device, { now });
  assert.equal(proof.includes(secret), false);
  assert.equal(verifyRegistrationProof(secret, challenge, device, proof, { now }), true);
  assert.equal(verifyRegistrationProof('x'.repeat(48), challenge, device, proof, { now }), false);
  assert.equal(verifyRegistrationProof(secret, challenge, { ...device, deviceId: 'other' }, proof, { now }), false);
});

test('challenge freshness is bounded', () => {
  const issued = Date.parse('2026-09-09T10:00:00Z');
  const challenge = createChallenge({ now: () => issued, randomBytes: (size) => Buffer.alloc(size, 3) });
  assert.equal(validateChallenge(challenge, { now: () => issued + 29_000 }), challenge);
  assert.throws(() => validateChallenge(challenge, { now: () => issued + 31_000 }), /expired_challenge/);
});

test('JSON line framing handles fragmentation and rejects malformed or oversized frames', () => {
  const decoder = new JsonLineDecoder({ maxFrameBytes: 64 });
  assert.deepEqual(decoder.push(Buffer.from('{"a":')), []);
  assert.deepEqual(decoder.push(Buffer.from('1}\n{"b":2}\n')), [{ a: 1 }, { b: 2 }]);
  assert.throws(() => new JsonLineDecoder({ maxFrameBytes: 8 }).push(Buffer.from('123456789')), /frame_too_large/);
  assert.throws(() => new JsonLineDecoder().push(Buffer.from('{bad}\n')), /invalid_frame_json/);
  assert.throws(() => encodeJsonLine({ data: 'x'.repeat(100) }, { maxFrameBytes: 32 }), /frame_too_large/);
  assert.throws(() => new JsonLineDecoder().push(Buffer.from('{}\n'.repeat(65))), /too_many_frames/);
});

test('device identity is durable, private and independent from host IP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-id-'));
  const file = path.join(root, 'state/device.json');
  const first = await loadOrCreateDeviceIdentity(file, { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
  const second = await loadOrCreateDeviceIdentity(file);
  assert.equal(first.deviceId, 'cmdr-00000000-0000-4000-8000-000000000001');
  assert.equal(second.deviceId, first.deviceId);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(() => loadOrCreateDeviceIdentity(file, { configuredDeviceId: 'other-device' }), /configured_device_id_mismatch/);
});

test('device registry replaces duplicate sessions and rejects stale heartbeats', () => {
  let clock = 1_000;
  const registry = new CommanderDeviceRegistry({ heartbeatTimeoutMs: 500, now: () => clock, maxDevices: 2 });
  const first = registry.register(device, 'session-1', { name: 'one' });
  assert.equal(first.previous, undefined);
  registry.heartbeat('btc-radar', 'session-1', 0);
  assert.throws(() => registry.heartbeat('btc-radar', 'session-1', 0), /stale_heartbeat_sequence/);
  const second = registry.register(device, 'session-2', { name: 'two' });
  assert.equal(second.previous.sessionId, 'session-1');
  assert.throws(() => registry.heartbeat('btc-radar', 'session-1', 1), /stale_or_unknown_session/);
  clock += 600;
  assert.deepEqual(registry.expireStale(), ['btc-radar']);
  assert.equal(registry.get('btc-radar').status, 'offline');
});

test('Phase 2 configuration is disabled and loopback-only by default', () => {
  assert.equal(commanderEnabled(undefined), false);
  assert.equal(commanderEnabled('true'), true);
  assert.equal(commanderPort(undefined), 8790);
  assert.equal(assertPhase2GatewayHost('127.0.0.1'), '127.0.0.1');
  assert.throws(() => assertPhase2GatewayHost('0.0.0.0'), /phase2_gateway_must_be_loopback/);
  assert.equal(COMMANDER_OPERATIONS['shell.exec'], undefined);
});

test('secret files require private permissions and gateway map stores paths, not secrets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-secret-'));
  const secretFile = path.join(root, 'agent.secret');
  await fs.writeFile(secretFile, `${secret}\n`, { mode: 0o600 });
  assert.equal(await loadCommanderSecret(secretFile), secret);
  await fs.chmod(secretFile, 0o644);
  await assert.rejects(() => loadCommanderSecret(secretFile), /permissions_too_open/);
  await fs.chmod(secretFile, 0o600);
  const mapFile = path.join(root, 'map.json');
  await fs.writeFile(mapFile, JSON.stringify({ version: 1, devices: { 'btc-radar': secretFile } }));
  const resolver = await loadGatewaySecretMap(mapFile);
  assert.equal(await resolver('btc-radar'), secret);
  assert.equal(await resolver('unknown'), null);
});
