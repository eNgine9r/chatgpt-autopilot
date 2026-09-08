import fs from 'node:fs/promises';
import http from 'node:http';
import { loadConfig } from './config.mjs';
import { JsonStateStore } from './store.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { DeterministicExecutor } from './executor.mjs';
import { ExecutionEngine } from './execution-engine.mjs';
import { translateGitHubEvent, verifyGitHubSignature } from './github-webhook.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const configPath = arg('--config', process.env.AUTOPILOT_V3_CONFIG ?? 'config/v3-projects.json');
const stateDir = arg('--state-dir', process.env.AUTOPILOT_V3_STATE_DIR ?? 'state-v3');
const secretFile = arg('--github-secret-file', process.env.AUTOPILOT_V3_GITHUB_SECRET_FILE ?? '');
const host = '127.0.0.1';
const port = Number(arg('--port', process.env.AUTOPILOT_V3_PORT ?? '8780'));

async function loadWebhookSecret(filePath) {
  if (!filePath) return '';
  const secret = (await fs.readFile(filePath, 'utf8')).trim();
  if (secret.length < 32 || secret.length > 256) throw new Error('invalid_github_webhook_secret');
  return secret;
}

const config = await loadConfig(configPath);

const webhookSecret = await loadWebhookSecret(secretFile);
const store = new JsonStateStore(stateDir);
await store.init();
const orchestrator = new Orchestrator(config, store);
const engine = new ExecutionEngine(orchestrator, new DeterministicExecutor());

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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, {
        ok: true,
        version: 3,
        mode: 'deterministic',
        aiCalls: 0,
        githubWebhook: Boolean(webhookSecret),
      });
    }
    if (req.method === 'GET' && req.url === '/projects') {
      return sendJson(res, 200, { projects: await store.list() });
    }
    if (req.method === 'POST' && req.url === '/github') {
      if (!webhookSecret) return sendJson(res, 503, { error: 'github_webhook_not_configured' });
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
    }
    if (req.method === 'POST' && req.url === '/events') {
      const rawBody = await readRawBody(req);
      const event = JSON.parse(rawBody.toString('utf8') || '{}');
      return sendJson(res, 200, await engine.handle(event));
    }
    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    const message = String(error?.message ?? error);
    const status = message === 'body_too_large' ? 413 : 400;
    return sendJson(res, status, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`autopilot-v3 listening http://${host}:${port}`);
});
