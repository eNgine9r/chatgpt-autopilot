import http from 'node:http';
import { translateGitHubEvent, verifyGitHubSignature } from './github-webhook.mjs';

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 262144) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function header(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : String(value ?? '');
}

function fail(res, error) {
  const message = String(error?.message ?? error);
  const status = message === 'body_too_large' ? 413 : 400;
  return sendJson(res, status, { error: message });
}

export function createControlServer({ store, engine, githubWebhook = false }) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, {
          ok: true,
          version: 3,
          mode: 'deterministic',
          aiCalls: 0,
          githubWebhook: Boolean(githubWebhook),
        });
      }
      if (req.method === 'GET' && req.url === '/projects') {
        return sendJson(res, 200, { projects: await store.list() });
      }
      if (req.method === 'POST' && req.url === '/events') {
        const rawBody = await readRawBody(req);
        const event = JSON.parse(rawBody.toString('utf8') || '{}');
        return sendJson(res, 200, await engine.handle(event));
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      return fail(res, error);
    }
  });
}

export function createGitHubServer({ config, engine, webhookSecret }) {
  if (!webhookSecret) return null;
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/github') {
        return sendJson(res, 404, { error: 'not_found' });
      }
      const rawBody = await readRawBody(req);
      const signature = header(req, 'x-hub-signature-256');
      if (!verifyGitHubSignature(webhookSecret, rawBody, signature)) {
        return sendJson(res, 401, { error: 'invalid_github_signature' });
      }
      const payload = JSON.parse(rawBody.toString('utf8') || '{}');
      const translated = translateGitHubEvent(
        config,
        header(req, 'x-github-event'),
        header(req, 'x-github-delivery'),
        payload,
      );
      if (translated.ignored) return sendJson(res, 202, translated);
      const result = await engine.handle(translated.event);
      return sendJson(res, 200, { accepted: true, ...result });
    } catch (error) {
      return fail(res, error);
    }
  });
}
