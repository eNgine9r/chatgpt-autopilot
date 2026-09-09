import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateTelegramInitData } from '../telegram-webapp-auth.mjs';
import { currentStep } from './state-machine.mjs';

const PROJECT_ID = /^[A-Za-z0-9._-]{1,120}$/;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function authHeader(req) {
  const value = String(req.headers.authorization ?? '');
  return value.startsWith('tma ') ? value.slice(4) : '';
}

function projectName(id) {
  if (id === 'btc-radar-development') return 'BTC Radar';
  if (id === 'nexolab-development') return 'NexoLab';
  return id;
}
async function fileFresh(file, maxAgeMs = 30000) {
  try {
    const stat = await fs.stat(file);
    return Date.now() - stat.mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

async function localJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `local_http_${response.status}`);
  return payload;
}

async function readControlHealth(controlBaseUrl) {
  try {
    const response = await fetch(`${controlBaseUrl}/health`, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
function normalizeProject(config, state) {
  const project = config.projects.find((item) => item.id === state.projectId);
  const step = project ? currentStep(project, state) : null;
  return {
    id: state.projectId,
    name: projectName(state.projectId),
    status: state.status,
    currentTask: state.task?.title || state.task?.id || 'Немає активної задачі',
    taskUrl: state.task?.url || '',
    stepId: step?.id || '',
    stepAction: step?.action || '',
    canApprove: state.status === 'waiting_approval' && step?.approval === 'user',
    canRetry: state.status === 'blocked',
    lastError: state.lastError || '',
    updatedAt: state.updatedAt || 0,
  };
}

export function createMiniAppServer({
  config,
  store,
  botToken,
  ownerUserId,
  controlBaseUrl = 'http://127.0.0.1:8780',
  telegramStateFile = 'state-v3/telegram.json',
  staticDir = 'web/miniapp',
  authenticateRequest = null,
}) {
  const staticFiles = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ]);

  function authenticate(req) {
    if (authenticateRequest) return authenticateRequest(req);
    return validateTelegramInitData(authHeader(req), {
      botToken,
      ownerUserId,
    });
  }

  async function statusPayload() {
    const [states, controlHealth, telegramOnline] = await Promise.all([
      store.list(),
      readControlHealth(controlBaseUrl),
      fileFresh(telegramStateFile),
    ]);
    return {
      ok: true,
      version: 3,
      mode: 'deterministic',
      generatedAt: Date.now(),
      aiCalls: 0,
      controlApi: { online: Boolean(controlHealth), localOnly: true },
      githubWebhook: { online: controlHealth?.githubWebhook === true },
      telegramBridge: { online: telegramOnline },
      projects: states.map((state) => normalizeProject(config, state)),
    };
  }
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname.replace(/^\/autopilot(?=\/|$)/, '') || '/';

      if (req.method === 'GET' && pathname === '/health') {
        return send(res, 200, { ok: true, version: 3, mode: 'miniapp', aiCalls: 0 });
      }
      if (req.method === 'GET' && staticFiles.has(pathname)) {
        const [name, type] = staticFiles.get(pathname);
        const body = await fs.readFile(path.join(staticDir, name), 'utf8');
        return send(res, 200, body, type);
      }
      if (pathname.startsWith('/api/')) {
        const auth = authenticate(req);
        if (!auth.ok) {
          const status = auth.error === 'forbidden_user' ? 403 : 401;
          return send(res, status, { ok: false, error: auth.error });
        }
      }
      if (req.method === 'GET' && pathname === '/api/status') {
        return send(res, 200, await statusPayload());
      }

      const match = pathname.match(/^\/api\/projects\/([^/]+)\/(approve|retry)$/);
      if (req.method === 'POST' && match) {
        const projectId = match[1];
        const action = match[2];
        if (!PROJECT_ID.test(projectId)) {
          return send(res, 400, { ok: false, error: 'invalid_project_id' });
        }
        const state = await store.load(projectId);
        const project = config.projects.find((item) => item.id === projectId && item.enabled !== false);
        if (!state || !project) return send(res, 404, { ok: false, error: 'unknown_project' });
        const step = currentStep(project, state);

        if (action === 'approve') {
          if (state.status !== 'waiting_approval' || step?.approval !== 'user') {
            return send(res, 409, { ok: false, error: `cannot_approve:${state.status}` });
          }
          const result = await localJson(`${controlBaseUrl}/events`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: `miniapp:${Date.now()}:approve:${projectId}`,
              projectId,
              kind: 'approval.granted',
              stepId: step.id,
            }),
          });
          return send(res, 200, { ok: true, action, projectId, state: result.state });
        }
        if (state.status !== 'blocked') {
          return send(res, 409, { ok: false, error: `cannot_retry:${state.status}` });
        }
        const result = await localJson(`${controlBaseUrl}/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: `miniapp:${Date.now()}:retry:${projectId}`,
            projectId,
            kind: 'retry',
          }),
        });
        return send(res, 200, { ok: true, action, projectId, state: result.state });
      }

      return send(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      return send(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
}
