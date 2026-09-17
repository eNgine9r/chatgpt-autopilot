import crypto from 'node:crypto';
import http from 'node:http';
import { pkceChallenge } from './oidc.mjs';

const MAX_BODY_BYTES = 32 * 1024;
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 128;
const CODE = /^[A-HJ-NP-Z2-9]{8}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function randomToken(bytes = 24) { return crypto.randomBytes(bytes).toString('base64url'); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function normalizeCode(value) { return String(value || '').toUpperCase().replace(/[^A-Z2-9]/g, ''); }
function parseCookies(header = '') {
  const result = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}
async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []; let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('request_body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
function redirect(res, location, cookie) {
  const headers = { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
  if (cookie) headers['set-cookie'] = cookie;
  res.writeHead(302, headers); res.end();
}

export class CommanderPairingOperatorServer {
  constructor({ host = '127.0.0.1', port = 0, publicBaseUrl, pairingService, trustStore, oidcClient = null, now = Date.now, logger = console } = {}) {
    if (!pairingService || typeof pairingService.createRequest !== 'function' || typeof pairingService.inspect !== 'function') throw new Error('pairing_operator_service_required');
    if (!trustStore || typeof trustStore.list !== 'function') throw new Error('pairing_operator_trust_store_required');
    let base;
    try { base = new URL(publicBaseUrl); } catch { throw new Error('invalid_pairing_public_base_url'); }
    if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('pairing_public_base_url_must_be_https');
    this.host = host; this.port = Number(port); this.publicBaseUrl = base.toString().replace(/\/$/, '');
    this.pairingService = pairingService; this.trustStore = trustStore; this.oidcClient = oidcClient;
    this.now = now; this.logger = logger; this.server = null; this.sessions = new Map();
  }

  async start() {
    if (this.server) throw new Error('pairing_operator_already_started');
    const server = http.createServer((req, res) => this.#route(req, res).catch((error) => this.#fail(res, error)));
    server.maxHeadersCount = 64; server.headersTimeout = 10_000; server.requestTimeout = 15_000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: this.host, port: this.port }, () => { server.off('error', reject); resolve(); });
    });
    this.server = server; return server.address();
  }

  async stop() {
    const server = this.server; this.server = null; this.sessions.clear();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }

  async #route(req, res) {
    this.#securityHeaders(res);
    const url = new URL(req.url || '/', this.publicBaseUrl);
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/device/pair') return this.#devicePair(req, res);
    if (req.method === 'POST' && url.pathname === '/api/device/status') return this.#deviceStatus(req, res);

    const { session, cookie } = this.#session(req);
    if (req.method === 'GET' && url.pathname === '/auth/login') return this.#login(res, session, cookie);
    if (req.method === 'GET' && url.pathname === '/auth/callback') return this.#callback(url, res, session, cookie);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/device')) return this.#devicePage(res, session, cookie);
    if (req.method === 'POST' && url.pathname === '/device/review') return this.#review(req, res, session, cookie);
    if (req.method === 'POST' && url.pathname === '/device/approve') return this.#decision(req, res, session, cookie, true);
    if (req.method === 'POST' && url.pathname === '/device/reject') return this.#decision(req, res, session, cookie, false);
    if (req.method === 'POST' && url.pathname === '/device/revoke') return this.#revoke(req, res, session, cookie);
    return this.#page(res, 404, 'Not found', '<p>The requested page does not exist.</p>', cookie);
  }

  async #devicePair(req, res) {
    const body = await this.#json(req);
    const created = await this.pairingService.createRequest(body);
    return sendJson(res, 201, created);
  }

  async #deviceStatus(req, res) {
    const body = await this.#json(req);
    return sendJson(res, 200, await this.pairingService.status(body));
  }

  async #login(res, session, cookie) {
    if (!this.oidcClient) return this.#page(res, 503, 'Sign-in unavailable', '<p>OIDC is not configured.</p>', cookie);
    const state = randomToken(); const nonce = randomToken(); const verifier = randomToken(48);
    session.oidc = { state, nonce, verifier, createdAt: this.now() };
    const location = await this.oidcClient.authorizationUrl({ state, nonce, codeChallenge: pkceChallenge(verifier) });
    return redirect(res, location, cookie);
  }

  async #callback(url, res, session, cookie) {
    if (!session.oidc || this.now() - session.oidc.createdAt > 10 * 60_000) throw new Error('oidc_session_expired');
    if (url.searchParams.get('state') !== session.oidc.state) throw new Error('oidc_state_mismatch');
    const code = url.searchParams.get('code');
    if (!code) throw new Error('oidc_code_missing');
    const result = await this.oidcClient.exchange({ code, codeVerifier: session.oidc.verifier, expectedNonce: session.oidc.nonce });
    session.operator = result.operator; delete session.oidc;
    return redirect(res, `${this.publicBaseUrl}/device`, cookie);
  }

  async #devicePage(res, session, cookie, message = '') {
    const auth = session.operator
      ? `<p class="ok">Signed in as ${escapeHtml(session.operator.email || session.operator.subject)}</p>`
      : '<p><a class="button" href="/auth/login">Sign in with Google</a></p>';
    const form = session.operator ? `<form method="post" action="/device/review">
      <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
      <label>Pairing code <input name="code" autocomplete="one-time-code" maxlength="11" required></label>
      <button type="submit">Review device</button></form>` : '';
    const devices = session.operator ? await this.#deviceTable(session) : '';
    return this.#page(res, 200, 'Commander device pairing', `${message ? `<p class="ok">${escapeHtml(message)}</p>` : ''}${auth}${form}${devices}`, cookie);
  }

  async #review(req, res, session, cookie) {
    this.#requireOperator(session);
    const form = await this.#form(req); this.#csrf(session, form.get('csrf'));
    const code = normalizeCode(form.get('code'));
    if (!CODE.test(code)) throw new Error('invalid_pairing_user_code');
    const device = await this.pairingService.inspect({ userCode: code });
    session.reviewCode = code;
    const body = `<h2>Review device</h2><dl><dt>Name</dt><dd>${escapeHtml(device.displayName || device.deviceId)}</dd>
      <dt>Device ID</dt><dd>${escapeHtml(device.deviceId)}</dd><dt>Key fingerprint</dt><dd><code>${escapeHtml(device.fingerprint)}</code></dd>
      <dt>Requested scopes</dt><dd>${device.scopes?.length ? device.scopes.map((scope) => `<code>${escapeHtml(scope)}</code>`).join('<br>') : 'None'}</dd>
      <dt>Expires</dt><dd>${escapeHtml(device.expiresAt)}</dd></dl>
      <form class="inline" method="post" action="/device/approve"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><button type="submit">Approve</button></form>
      <form class="inline" method="post" action="/device/reject"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><button class="danger" type="submit">Reject</button></form>`;
    return this.#page(res, 200, 'Review Commander device', body, cookie);
  }

  async #decision(req, res, session, cookie, approve) {
    this.#requireOperator(session);
    const form = await this.#form(req); this.#csrf(session, form.get('csrf'));
    if (!session.reviewCode) throw new Error('pairing_review_required');
    const code = session.reviewCode; delete session.reviewCode;
    const result = approve
      ? await this.pairingService.approve({ userCode: code, operator: session.operator })
      : await this.pairingService.reject({ userCode: code, operator: session.operator });
    return this.#devicePage(res, session, cookie, `Device ${result.deviceId} ${approve ? 'approved' : 'rejected'}.`);
  }

  async #revoke(req, res, session, cookie) {
    this.#requireOperator(session);
    const form = await this.#form(req); this.#csrf(session, form.get('csrf'));
    const deviceId = String(form.get('deviceId') || '');
    if (!DEVICE_ID.test(deviceId)) throw new Error('invalid_pairing_device_id');
    await this.trustStore.revokeDevice(deviceId, session.operator);
    return this.#devicePage(res, session, cookie, `Device ${deviceId} revoked.`);
  }

  async #deviceTable(session) {
    const devices = await this.trustStore.list();
    if (!devices.length) return '<h2>Paired devices</h2><p>No devices paired yet.</p>';
    const rows = devices.map((d) => `<tr><td>${escapeHtml(d.deviceId)}</td><td>${escapeHtml(d.status)}</td><td><code>${escapeHtml(d.fingerprint)}</code></td><td>${d.status === 'trusted' ? `<form method="post" action="/device/revoke"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><input type="hidden" name="deviceId" value="${escapeHtml(d.deviceId)}"><button class="danger" type="submit">Revoke</button></form>` : ''}</td></tr>`).join('');
    return `<h2>Paired devices</h2><table><thead><tr><th>Device</th><th>Status</th><th>Fingerprint</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  #session(req) {
    this.#pruneSessions();
    const cookies = parseCookies(req.headers.cookie);
    let id = cookies.commander_pairing_sid; let session = id ? this.sessions.get(id) : null;
    if (!session) {
      id = randomToken(32); session = { id, csrf: randomToken(), createdAt: this.now(), lastSeenAt: this.now() };
      this.sessions.set(id, session);
    }
    session.lastSeenAt = this.now();
    const secure = this.publicBaseUrl.startsWith('https://');
    const cookie = `commander_pairing_sid=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
    return { session, cookie };
  }

  #pruneSessions() {
    const cutoff = this.now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions) if (session.lastSeenAt < cutoff) this.sessions.delete(id);
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
  }
  #requireOperator(session) { if (!session.operator) throw new Error('operator_authentication_required'); }
  #csrf(session, value) {
    const a = Buffer.from(String(session.csrf)); const b = Buffer.from(String(value || ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('csrf_validation_failed');
  }
  async #form(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) throw new Error('unsupported_form_content_type');
    return new URLSearchParams(await readBody(req));
  }
  async #json(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('unsupported_json_content_type');
    let parsed; try { parsed = JSON.parse(await readBody(req)); } catch { throw new Error('invalid_json_body'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json_body');
    return parsed;
  }
  #securityHeaders(res) {
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('x-frame-options', 'DENY'); res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  }
  #page(res, status, title, content, cookie) {
    const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:920px;margin:40px auto;padding:0 20px;background:#0b0d10;color:#eef2f6}main{background:#151922;border:1px solid #2b3340;border-radius:16px;padding:24px}input,button,.button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #475265;background:#10141b;color:#fff}.button,button{cursor:pointer;text-decoration:none;background:#2559d6}.danger{background:#8e2c35}.inline{display:inline-block;margin-right:8px}.ok{color:#8de0a6}code{word-break:break-all}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px;border-bottom:1px solid #303743}label{display:grid;gap:8px;max-width:420px;margin:16px 0}dl{display:grid;grid-template-columns:140px 1fr;gap:10px}</style></head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`;
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }; if (cookie) headers['set-cookie'] = cookie;
    res.writeHead(status, headers); res.end(body);
  }
  #fail(res, error) {
    try { this.logger?.warn?.('commander_pairing_operator_request_failed', { error: String(error?.message || error) }); } catch {}
    if (res.headersSent) return res.end();
    const status = String(error?.message || '').includes('authentication_required') ? 401 : 400;
    return this.#page(res, status, 'Request rejected', `<p>${escapeHtml(error?.message || 'request_failed')}</p>`);
  }
}
