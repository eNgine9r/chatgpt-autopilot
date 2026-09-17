import crypto from 'node:crypto';

function parseJsonPart(value, name) {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw new Error(`invalid_oidc_${name}`); }
}

function httpsOrLocal(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`invalid_oidc_${name}`); }
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error(`oidc_${name}_must_be_https`);
  return url;
}

function requireString(value, name, max = 4096) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new Error(`invalid_oidc_${name}`);
  return value;
}

export function pkceChallenge(verifier) {
  requireString(verifier, 'pkce_verifier', 256);
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export class CommanderOidcClient {
  constructor({ issuer, clientId, clientSecret = '', redirectUri, providerId = 'google', fetchImpl = fetch, now = Date.now } = {}) {
    this.issuer = httpsOrLocal(requireString(issuer, 'issuer'), 'issuer').toString().replace(/\/$/, '');
    this.clientId = requireString(clientId, 'client_id');
    this.clientSecret = clientSecret ? requireString(clientSecret, 'client_secret') : '';
    this.redirectUri = httpsOrLocal(requireString(redirectUri, 'redirect_uri'), 'redirect_uri').toString();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(providerId)) throw new Error('invalid_oidc_provider_id');
    this.providerId = providerId;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.discoveryCache = null;
    this.jwksCache = null;
  }

  async discovery() {
    if (this.discoveryCache && this.discoveryCache.expiresAt > this.now()) return this.discoveryCache.value;
    const response = await this.fetchImpl(`${this.issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('oidc_discovery_failed');
    const value = await response.json();
    if (String(value.issuer || '').replace(/\/$/, '') !== this.issuer) throw new Error('oidc_issuer_mismatch');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) httpsOrLocal(value[key], key);
    this.discoveryCache = { value, expiresAt: this.now() + 5 * 60_000 };
    return value;
  }

  async authorizationUrl({ state, nonce, codeChallenge, scope = 'openid email profile' } = {}) {
    const metadata = await this.discovery();
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scope);
    url.searchParams.set('state', requireString(state, 'state', 256));
    url.searchParams.set('nonce', requireString(nonce, 'nonce', 256));
    url.searchParams.set('code_challenge', requireString(codeChallenge, 'code_challenge', 256));
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchange({ code, codeVerifier, expectedNonce } = {}) {
    const metadata = await this.discovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code: requireString(code, 'code'), client_id: this.clientId,
      redirect_uri: this.redirectUri, code_verifier: requireString(codeVerifier, 'pkce_verifier', 256),
    });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    const response = await this.fetchImpl(metadata.token_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body,
    });
    if (!response.ok) throw new Error('oidc_token_exchange_failed');
    const payload = await response.json();
    const claims = await this.verifyIdToken(requireString(payload.id_token, 'id_token', 32 * 1024), expectedNonce);
    return {
      operator: {
        provider: this.providerId, subject: claims.sub,
        ...(typeof claims.email === 'string' && claims.email ? { email: claims.email } : {}),
      },
      claims,
    };
  }

  async verifyIdToken(token, expectedNonce) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new Error('invalid_oidc_id_token');
    const header = parseJsonPart(parts[0], 'header');
    const claims = parseJsonPart(parts[1], 'claims');
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('unsupported_oidc_signing_algorithm');
    const metadata = await this.discovery();
    const keys = await this.#jwks(metadata.jwks_uri);
    const jwk = keys.find((item) => item?.kid === header.kid && item?.kty === 'RSA');
    if (!jwk) throw new Error('oidc_signing_key_not_found');
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    if (!crypto.verify('RSA-SHA256', signed, key, signature)) throw new Error('oidc_signature_invalid');
    const nowSeconds = Math.floor(this.now() / 1000);
    if (String(claims.iss || '').replace(/\/$/, '') !== this.issuer) throw new Error('oidc_claim_issuer_mismatch');
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(this.clientId)) throw new Error('oidc_claim_audience_mismatch');
    if (audience.length > 1 && claims.azp !== this.clientId) throw new Error('oidc_claim_authorized_party_mismatch');
    if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds) throw new Error('oidc_token_expired');
    if (!Number.isFinite(claims.iat) || claims.iat > nowSeconds + 300) throw new Error('oidc_token_iat_invalid');
    if (claims.nonce !== requireString(expectedNonce, 'nonce', 256)) throw new Error('oidc_nonce_mismatch');
    requireString(claims.sub, 'subject', 512);
    return claims;
  }

  async #jwks(uri) {
    if (this.jwksCache && this.jwksCache.expiresAt > this.now()) return this.jwksCache.value;
    const response = await this.fetchImpl(uri, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('oidc_jwks_fetch_failed');
    const parsed = await response.json();
    if (!Array.isArray(parsed?.keys) || parsed.keys.length > 64) throw new Error('invalid_oidc_jwks');
    this.jwksCache = { value: parsed.keys, expiresAt: this.now() + 5 * 60_000 };
    return parsed.keys;
  }
}
