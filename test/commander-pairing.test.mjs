import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { loadOrCreateDeviceKeypair, devicePublicKeyFingerprint } from '../src/commander/agent/device-keypair.mjs';
import { CommanderAgentClient } from '../src/commander/agent/client.mjs';
import { CommanderGatewayServer } from '../src/commander/gateway/server.mjs';
import { CommanderTrustStore } from '../src/commander/gateway/trust-store.mjs';
import { CommanderPairingService } from '../src/commander/pairing/service.mjs';
import { createChallenge, createDeviceSignatureProof, verifyDeviceSignatureProof } from '../src/commander/session/auth.mjs';
import { protocolEnvelope } from '../src/commander/contracts/index.mjs';

const silentLogger = { info() {}, warn() {}, error() {} };
const operator = { provider: 'google', subject: 'google-subject-123', email: 'operator@example.com' };

async function rootFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-pairing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('Ed25519 device keypair is durable, private and proves Commander challenges', async (t) => {
  const root = await rootFixture(t);
  const file = path.join(root, 'state', 'device-keypair.json');
  const first = await loadOrCreateDeviceKeypair(file);
  const second = await loadOrCreateDeviceKeypair(file);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fingerprint, devicePublicKeyFingerprint(first.publicKeyPem));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);

  const now = () => Date.parse('2026-09-17T10:00:00Z');
  const challenge = createChallenge({ now, randomBytes: (size) => Buffer.alloc(size, 9) });
  const device = { ...protocolEnvelope(), deviceId: 'device-a', platform: 'linux', agentVersion: '0.1.0', capabilities: [] };
  const proof = createDeviceSignatureProof(first.privateKeyPem, challenge, device, { now });
  assert.equal(verifyDeviceSignatureProof(first.publicKeyPem, challenge, device, proof, { now }), true);
  assert.equal(verifyDeviceSignatureProof(first.publicKeyPem, challenge, { ...device, deviceId: 'device-b' }, proof, { now }), false);
});

test('one-time pairing code approves trust without storing raw device or user codes', async (t) => {
  const root = await rootFixture(t);
  const keypair = await loadOrCreateDeviceKeypair(path.join(root, 'device-keypair.json'));
  const trustStore = new CommanderTrustStore({ filePath: path.join(root, 'trust.json') });
  const pairing = new CommanderPairingService({
    stateFile: path.join(root, 'pairing.json'), trustStore,
    verificationUri: 'https://commander.example.test/device',
  });
  const created = await pairing.createRequest({ deviceId: 'device-a', publicKeyPem: keypair.publicKeyPem, displayName: 'Device A' });
  assert.match(created.userCode, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.ok(created.deviceCode.length >= 32);
  const rawState = await fs.readFile(path.join(root, 'pairing.json'), 'utf8');
  assert.equal(rawState.includes(created.userCode), false);
  assert.equal(rawState.includes(created.deviceCode), false);

  const pending = await pairing.status({ requestId: created.requestId, deviceCode: created.deviceCode });
  assert.equal(pending.status, 'pending');
  await assert.rejects(() => pairing.status({ requestId: created.requestId, deviceCode: `${created.deviceCode}bad` }), /not_authorized/);

  const approved = await pairing.approve({ userCode: created.userCode, operator });
  assert.equal(approved.status, 'approved');
  assert.equal((await trustStore.get('device-a')).status, 'trusted');
  assert.equal(await trustStore.resolvePublicKey('device-a'), keypair.publicKeyPem);
  assert.equal((await pairing.status({ requestId: created.requestId, deviceCode: created.deviceCode })).status, 'approved');
  await assert.rejects(() => pairing.approve({ userCode: created.userCode, operator }), /not_pending/);

  await trustStore.revokeDevice('device-a', operator);
  assert.equal(await trustStore.resolvePublicKey('device-a'), null);
  assert.equal((await trustStore.get('device-a')).status, 'revoked');
  assert.equal((await fs.stat(path.join(root, 'trust.json'))).mode & 0o777, 0o600);
});

test('pairing requests expire fail-closed', async (t) => {
  const root = await rootFixture(t);
  let clock = Date.parse('2026-09-17T10:00:00Z');
  const keypair = await loadOrCreateDeviceKeypair(path.join(root, 'device-keypair.json'));
  const trustStore = new CommanderTrustStore({ filePath: path.join(root, 'trust.json'), now: () => clock });
  const pairing = new CommanderPairingService({
    stateFile: path.join(root, 'pairing.json'), trustStore,
    verificationUri: 'https://commander.example.test/device', ttlMs: 60_000, now: () => clock,
  });
  const created = await pairing.createRequest({ deviceId: 'device-a', publicKeyPem: keypair.publicKeyPem });
  clock += 60_001;
  assert.equal((await pairing.status({ requestId: created.requestId, deviceCode: created.deviceCode })).status, 'expired');
  await assert.rejects(() => pairing.approve({ userCode: created.userCode, operator }), /not_pending/);
  assert.equal(await trustStore.get('device-a'), null);
});

test('paired Ed25519 device authenticates to Gateway without a shared HMAC secret', async (t) => {
  const root = await rootFixture(t);
  const identity = { version: 1, deviceId: 'paired-device', createdAt: new Date().toISOString() };
  const keypair = await loadOrCreateDeviceKeypair(path.join(root, 'device-keypair.json'));
  const trustStore = new CommanderTrustStore({ filePath: path.join(root, 'trust.json') });
  await trustStore.trustDevice({ deviceId: identity.deviceId, publicKeyPem: keypair.publicKeyPem, operator });
  const gateway = new CommanderGatewayServer({
    host: '127.0.0.1', port: 0, heartbeatIntervalMs: 250, heartbeatTimeoutMs: 1_000,
    deviceKeyResolver: (deviceId) => trustStore.resolvePublicKey(deviceId), logger: silentLogger,
  });
  const address = await gateway.start();
  const agent = new CommanderAgentClient({
    gatewayHost: '127.0.0.1', gatewayPort: address.port,
    identity, devicePrivateKeyPem: keypair.privateKeyPem, logger: silentLogger,
    reconnectBaseMs: 100, reconnectMaxMs: 200, reconnectJitterRatio: 0,
  });
  t.after(async () => { await agent.stop(); await gateway.stop(); });
  const registered = once(agent, 'registered');
  agent.start();
  const [{ deviceId }] = await registered;
  assert.equal(deviceId, identity.deviceId);
  assert.equal(gateway.registry.get(identity.deviceId).status, 'online');
});

test('pairing request creation is rate-limited per device', async (t) => {
  const root = await rootFixture(t);
  const keypair = await loadOrCreateDeviceKeypair(path.join(root, 'device-keypair.json'));
  const trustStore = new CommanderTrustStore({ filePath: path.join(root, 'trust.json') });
  const pairing = new CommanderPairingService({
    stateFile: path.join(root, 'pairing.json'), trustStore,
    verificationUri: 'https://commander.example.test/device', maxCreatesPerWindow: 1,
  });
  await pairing.createRequest({ deviceId: 'device-a', publicKeyPem: keypair.publicKeyPem });
  await assert.rejects(() => pairing.createRequest({ deviceId: 'device-a', publicKeyPem: keypair.publicKeyPem }), /pairing_rate_limited/);
});
