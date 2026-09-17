import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { buildCommanderMcpServer } from './server.mjs';

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BODY_BYTES = 1024 * 1024;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw Object.assign(new Error('remote_mcp_request_body_too_large'), { statusCode: 413 });
  const chunks = []; let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('remote_mcp_request_body_too_large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function requestHeaders(req) {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(req.headers)) {
    if (raw === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (Array.isArray(raw)) for (const value of raw) headers.append(name, value);
    else headers.set(name, String(raw));
  }
  return headers;
}

function writeCommonHeaders(res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
}

function sendJson(res, status, payload, extraHeaders = {}) {
  writeCommonHeaders(res);
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function sendWebResponse(res, response) {
  writeCommonHeaders(res);
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) res.setHeader(name, value);
  }
  if (!response.body) { res.end(); return; }
  await pipeline(Readable.fromWeb(response.body), res);
}

export class CommanderRemoteMcpHttpServer {
  constructor({ host = '127.0.0.1', port = 0, deviceId, client, verifyAuthorization, logger = console } = {}) {
    if (!DEVICE_ID.test(String(deviceId || ''))) throw new Error('remote_mcp_device_id_required');
    if (!client || typeof client.getDevice !== 'function' || typeof client.request !== 'function') throw new Error('remote_mcp_public_client_required');
    if (typeof verifyAuthorization !== 'function') throw new Error('remote_mcp_auth_verifier_required');
    this.host = host; this.port = Number(port); this.deviceId = deviceId; this.client = client;
    this.verifyAuthorization = verifyAuthorization; this.logger = logger; this.server = null;
    this.mcpHandler = createMcpHandler(async () => {
      const deviceEntry = await this.client.getDevice(this.deviceId);
      if (deviceEntry?.status !== 'online') throw new Error('commander_mcp_device_offline');
      return buildCommanderMcpServer({ client: this.client, deviceId: this.deviceId, deviceEntry });
    }, {
      legacy: 'reject',
      onerror: () => { try { this.logger?.warn?.('commander_remote_mcp_protocol_error'); } catch {} },
    });
  }

  async start() {
    if (this.server) throw new Error('remote_mcp_already_started');
    const server = http.createServer((req, res) => this.#route(req, res).catch((error) => this.#fail(res, error)));
    server.maxHeadersCount = 64; server.headersTimeout = 10_000; server.requestTimeout = 35_000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: this.host, port: this.port }, () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
    return server.address();
  }

  async stop() {
    const server = this.server; this.server = null;
    await this.mcpHandler.close();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }

  async #route(req, res) {
    const url = new URL(req.url || '/', `http://${this.host}`);
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (url.pathname !== '/mcp') return sendJson(res, 404, { error: 'not_found' });
    if (!this.verifyAuthorization(req.headers.authorization)) {
      req.resume();
      return sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="Commander MCP"' });
    }
    if (!['GET', 'POST', 'DELETE'].includes(String(req.method || '').toUpperCase())) {
      req.resume();
      return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, POST, DELETE' });
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort); res.once('close', abort);
    try {
      const method = String(req.method || 'GET').toUpperCase();
      const body = method === 'POST' ? await readBody(req) : undefined;
      const request = new Request(`http://${this.host}${req.url || '/mcp'}`, {
        method,
        headers: requestHeaders(req),
        ...(body ? { body } : {}),
        signal: controller.signal,
      });
      const response = await this.mcpHandler.fetch(request);
      await sendWebResponse(res, response);
    } finally {
      req.off('aborted', abort); res.off('close', abort);
    }
  }

  #fail(res, error) {
    try { this.logger?.warn?.('commander_remote_mcp_request_failed', { code: String(error?.message || 'request_failed') }); } catch {}
    if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
    return sendJson(res, Number(error?.statusCode) || 500, { error: 'request_failed' });
  }
}
