import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommanderTrustStore } from '../src/commander/gateway/trust-store.mjs';
import { CommanderPairingService } from '../src/commander/pairing/service.mjs';
import { CommanderPairingOperatorServer } from '../src/commander/pairing/operator-server.mjs';
import { CommanderOidcClient, pkceChallenge } from '../src/commander/pairing/oidc.mjs';
import { runCommanderPairingRegistration } from '../src/commander/pairing/register.mjs';
import { loadOrCreateDeviceKeypair } from '../src/commander/agent/device-keypair.mjs';

const silent = { info() {}, warn() {}, error() {} };
const operator = { provider: 'google', subject: 'subject-1', email: 'operator@example.com' };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-pairing-operator-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const trustStore = new CommanderTrustStore({ filePath: path.join(root, 'trust.json') });
  const pairingService = new CommanderPairingService({
    stateFile: path.join(root, 'pairing.json'), trustStore,
    verificationUri: 'http://127.0.0.1/device',
  });
  await pairingService.load();
  return { root, trustStore, pairingService };
}

function cookieFrom(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

function csrfFrom(html) {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  assert.ok(match, 'csrf field present');
  return match[1];
}

test('operator server completes OIDC-authenticated review/approve flow and persists reviewed scopes', async (t) => {
  const { root, trustStore, pairingService } = await fixture(t);
  const keypair = await loadOrCreateDeviceKeypair(path.join(root, 'device-key.json'));
  const requested = await pairingService.createRequest({
    deviceId: 'device-a', publicKeyPem: keypair.publicKeyPem, displayName: 'NexoLab Edge',
    scopes: ['project:nexolab', 'capability:file.read'],
  });
  let expectedNonce = '';
  const oidcClient = {
    async authorizationUrl({ state, nonce, codeChallenge }) {
      assert.equal(codeChallenge.length > 20, true);
      expectedNonce = nonce;
      return `https://idp.example/authorize?state=${encodeURIComponent(state)}&nonce=${encodeURIComponent(nonce)}`;
    },
    async exchange({ code, expectedNonce: nonce }) {
      assert.equal(code, 'auth-code');
      assert.equal(nonce, expectedNonce);
      return { operator, claims: { sub: operator.subject } };
    },
  };
  const server = new CommanderPairingOperatorServer({
    host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1',
    pairingService, trustStore, oidcClient, logger: silent,
  });
  const address = await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const cookie = cookieFrom(login);
  assert.match(cookie, /^commander_pairing_sid=/);
  const authUrl = new URL(login.headers.get('location'));
  const state = authUrl.searchParams.get('state');
  assert.ok(state);

  const callback = await fetch(`${base}/auth/callback?code=auth-code&state=${encodeURIComponent(state)}`, {
    headers: { cookie }, redirect: 'manual',
  });
  assert.equal(callback.status, 302);

  const page = await fetch(`${base}/device`, { headers: { cookie } });
  const pageHtml = await page.text();
  assert.match(pageHtml, /Signed in as operator@example.com/);
  const csrf = csrfFrom(pageHtml);

  const review = await fetch(`${base}/device/review`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, code: requested.userCode }),
  });
  const reviewHtml = await review.text();
  assert.equal(review.status, 200);
  assert.match(reviewHtml, /NexoLab Edge/);
  assert.match(reviewHtml, /project:nexolab/);
  assert.match(reviewHtml, /capability:file.read/);

  const approve = await fetch(`${base}/device/approve`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(approve.status, 200);
  const record = await trustStore.get('device-a');
  assert.equal(record.status, 'trusted');
  assert.deepEqual(record.approvedScopes, ['project:nexolab', 'capability:file.read']);
  const status = await pairingService.status({ requestId: requested.requestId, deviceCode: requested.deviceCode });
  assert.equal(status.status, 'approved');
});

test('operator actions reject missing authentication and invalid CSRF', async (t) => {
  const { trustStore, pairingService } = await fixture(t);
  const server = new CommanderPairingOperatorServer({
    host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1', pairingService, trustStore, logger: silent,
  });
  const address = await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${address.port}`;
  const page = await fetch(`${base}/device`);
  const cookie = cookieFrom(page);
  const review = await fetch(`${base}/device/review`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: 'wrong', code: 'ABCDEFGH' }),
  });
  assert.equal(review.status, 401);
});

test('OIDC client verifies discovery, PKCE, signed ID token, audience and nonce', async () => {
  const now = Date.parse('2026-09-17T10:00:00Z');
  const issuer = 'https://accounts.example.test';
  const clientId = 'commander-client';
  const nonce = 'nonce-123';
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  publicJwk.kid = 'key-1'; publicJwk.use = 'sig'; publicJwk.alg = 'RS256';
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'key-1' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: issuer, aud: clientId, sub: 'operator-subject', email: 'operator@example.com',
    nonce, iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 300,
  })).toString('base64url');
  const signed = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url');
  const token = `${signed}.${signature}`;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push([String(url), options]);
    if (String(url).endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify({
      issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/token')) return new Response(JSON.stringify({ id_token: token }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/jwks')) return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error('unexpected_url');
  };
  const client = new CommanderOidcClient({
    issuer, clientId, redirectUri: 'https://commander.example.test/auth/callback', fetchImpl, now: () => now,
  });
  const verifier = 'v'.repeat(48);
  const authorizationUrl = new URL(await client.authorizationUrl({ state: 'state-1', nonce, codeChallenge: pkceChallenge(verifier) }));
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  const exchanged = await client.exchange({ code: 'code-1', codeVerifier: verifier, expectedNonce: nonce });
  assert.deepEqual(exchanged.operator, { provider: 'google', subject: 'operator-subject', email: 'operator@example.com' });
  await assert.rejects(() => client.verifyIdToken(token, 'wrong-nonce'), /oidc_nonce_mismatch/);
  assert.ok(calls.length >= 3);
});

test('terminal registration prints URL/code and returns approved decision', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-register-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const messages = [];
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith('/api/device/pair')) {
      const input = JSON.parse(options.body);
      assert.equal(input.deviceId, 'device-cli');
      assert.deepEqual(input.scopes, ['project:nexolab', 'capability:file.read']);
      return new Response(JSON.stringify({
        requestId: 'pair-123', deviceCode: 'd'.repeat(43), userCode: 'ABCD2345',
        verificationUri: 'https://commander.example.test/device', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).endsWith('/api/device/status')) return new Response(JSON.stringify({
      requestId: 'pair-123', deviceId: 'device-cli', fingerprint: 'fp', status: 'approved', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error('unexpected_url');
  };
  const result = await runCommanderPairingRegistration({
    HOME: root, COMMANDER_PAIRING_BASE_URL: 'https://commander.example.test', COMMANDER_DEVICE_ID: 'device-cli',
    COMMANDER_DEVICE_NAME: 'CLI device', COMMANDER_PAIRING_SCOPES: 'project:nexolab, capability:file.read',
  }, { logger: { info: (value) => messages.push(value) }, fetchImpl });
  assert.equal(result.status, 'approved');
  assert.ok(messages.some((line) => line.includes('ABCD2345')));
  assert.ok(messages.some((line) => line.includes('https://commander.example.test/device')));
});
