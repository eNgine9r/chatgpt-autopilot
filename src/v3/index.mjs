import http from 'node:http';
import { loadConfig } from './config.mjs';
import { JsonStateStore } from './store.mjs';
import { Orchestrator } from './orchestrator.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const configPath = arg('--config', process.env.AUTOPILOT_V3_CONFIG ?? 'config/v3-projects.json');
const stateDir = arg('--state-dir', process.env.AUTOPILOT_V3_STATE_DIR ?? 'state-v3');
const host = '127.0.0.1';
const port = Number(arg('--port', process.env.AUTOPILOT_V3_PORT ?? '8780'));

const config = await loadConfig(configPath);
const store = new JsonStateStore(stateDir);
await store.init();
const orchestrator = new Orchestrator(config, store);

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 262144) throw new Error('body_too_large');
  }
  return JSON.parse(raw || '{}');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true, version: 3, mode: 'deterministic', aiCalls: 0 });
    }
    if (req.method === 'GET' && req.url === '/projects') {
      return sendJson(res, 200, { projects: await store.list() });
    }
    if (req.method !== 'POST' || req.url !== '/events') {
      return sendJson(res, 404, { error: 'not_found' });
    }
    const event = await readBody(req);
    return sendJson(res, 200, await orchestrator.handle(event));
  } catch (error) {
    return sendJson(res, 400, { error: String(error?.message ?? error) });
  }
});

server.listen(port, host, () => {
  console.log(`autopilot-v3 listening http://${host}:${port}`);
});
