import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { protocolEnvelope } from '../commander/contracts/index.mjs';
import { readCommanderActivity } from '../integrations/github/commander/activity-store.mjs';
import { validateTelegramInitData } from '../telegram-webapp-auth.mjs';
import { currentStep } from './state-machine.mjs';

const PROJECT_ID = /^[A-Za-z0-9._-]{1,120}$/;
const COMMANDER_HEALTH_TIMEOUT_MS = 1_500;
const SYSTEM_UNITS = Object.freeze({
  commanderGateway: 'chatgpt-autopilot-commander-gateway.service',
  commanderBridge: 'chatgpt-autopilot-commander-github-bridge.service',
  autopilot: 'chatgpt-autopilot-v3.service',
  miniapp: 'chatgpt-autopilot-v3-miniapp.service',
  telegram: 'chatgpt-autopilot-v3-telegram.service',
  legacyRdc: 'remote-desktop-commander.service',
  secureTunnel: 'chatgpt-autopilot-commander-secure-mcp-tunnel.service',
});

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
  if (id === 'nexolab-development') return 'NEXOLAB';
  return id;
}

function deviceName(id, fallback = '') {
  if (id === 'btc-radar') return 'BTC Radar';
  if (id === 'nexolab-edge-01') return 'NEXOLAB';
  return fallback || id;
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

function automationState(projects) {
  if (projects.some((item) => ['waiting_approval', 'blocked'].includes(item.status))) return 'attention';
  if (projects.some((item) => ['running', 'ready'].includes(item.status))) return 'active';
  if (projects.length && projects.every((item) => item.status === 'paused')) return 'paused';
  return 'idle';
}

function capabilityGroups(capabilities = []) {
  const operations = new Set(capabilities.map((item) => item.operation));
  return {
    terminal: ['execution.start', 'execution.input', 'execution.get', 'execution.output'].every((op) => operations.has(op)),
    files: operations.has('file.read') && operations.has('file.write'),
    services: operations.has('service.status') && operations.has('service.restart'),
    git: operations.has('git.status') && operations.has('git.diff') && operations.has('git.log'),
  };
}

function healthRequest(deviceId) {
  return {
    ...protocolEnvelope(),
    requestId: `miniapp-${crypto.randomUUID().replaceAll('-', '')}`,
    deviceId,
    operation: 'device.health',
    params: {},
    deadlineAt: new Date(Date.now() + COMMANDER_HEALTH_TIMEOUT_MS).toISOString(),
  };
}

async function readSystemServices(serviceStatusReader) {
  const entries = await Promise.all(Object.entries(SYSTEM_UNITS).map(async ([key, unit]) => {
    try {
      const status = serviceStatusReader ? await serviceStatusReader(unit) : null;
      return [key, status || { unit, activeState: 'unknown', subState: 'unknown', unitFileState: 'unknown' }];
    } catch {
      return [key, { unit, activeState: 'unknown', subState: 'unknown', unitFileState: 'unknown' }];
    }
  }));
  return Object.fromEntries(entries);
}

async function readCommander(commanderClient, activityFile, services) {
  const activity = activityFile ? await readCommanderActivity(activityFile, 12) : [];
  const base = {
    online: false,
    state: 'offline',
    onlineDevices: 0,
    totalDevices: 0,
    devices: [],
    activity,
    transport: {
      name: 'GitHub Bridge',
      active: services.commanderBridge?.activeState === 'active',
      pollSeconds: 3,
    },
    security: {
      noNewPrivs: true,
      ownerOnly: true,
      adminOperations: false,
      rootShell: false,
    },
  };
  if (!commanderClient) return base;

  try {
    const listed = await commanderClient.listDevices({ timeoutMs: COMMANDER_HEALTH_TIMEOUT_MS });
    const entries = Array.isArray(listed?.devices) ? listed.devices : [];
    const devices = await Promise.all(entries.map(async (entry) => {
      const id = entry?.device?.deviceId || '';
      let health = null;
      if (entry?.status === 'online' && id) {
        try {
          const result = await commanderClient.request(healthRequest(id), { timeoutMs: COMMANDER_HEALTH_TIMEOUT_MS });
          if (result?.ok) health = result.data || null;
        } catch {}
      }
      return {
        id,
        name: deviceName(id, entry?.device?.displayName),
        status: entry?.status || 'offline',
        agentVersion: entry?.device?.agentVersion || '',
        connectedAt: entry?.connectedAt || 0,
        lastHeartbeatAt: entry?.lastHeartbeatAt || 0,
        capabilities: capabilityGroups(entry?.device?.capabilities || []),
        health,
      };
    }));
    const onlineDevices = devices.filter((item) => item.status === 'online').length;
    const operational = devices.length > 0
      && onlineDevices === devices.length
      && base.transport.active;
    return {
      ...base,
      online: operational,
      state: operational ? 'operational' : onlineDevices ? 'degraded' : 'offline',
      onlineDevices,
      totalDevices: devices.length,
      devices,
    };
  } catch {
    return base;
  }
}

function serviceCompatibleOnline(service) {
  return !service || service.activeState === 'active' || service.activeState === 'unknown';
}

function systemAlerts({ commander, autopilot, services }) {
  let count = 0;
  count += Math.max(0, commander.totalDevices - commander.onlineDevices);
  if (autopilot.automationState === 'attention') count += 1;
  if (services.commanderGateway?.activeState !== 'active') count += 1;
  if (services.commanderBridge?.activeState !== 'active') count += 1;
  return count;
}

export function createMiniAppServer({
  config,
  store,
  botToken,
  ownerUserId,
  controlBaseUrl = 'http://127.0.0.1:8780',
  telegramStateFile = 'state-v3/telegram.json',
  commanderClient = null,
  commanderActivityFile = '',
  serviceStatusReader = null,
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
    const [states, controlHealth, telegramOnline, services] = await Promise.all([
      store.list(),
      readControlHealth(controlBaseUrl),
      fileFresh(telegramStateFile),
      readSystemServices(serviceStatusReader),
    ]);
    const projects = states.map((state) => normalizeProject(config, state));
    const autopilot = {
      infrastructureOnline: serviceCompatibleOnline(services.autopilot) && Boolean(controlHealth),
      automationState: automationState(projects),
      projects,
      aiCalls: 0,
      githubWebhook: { online: controlHealth?.githubWebhook === true },
      telegramBridge: {
        online: serviceCompatibleOnline(services.telegram) && telegramOnline,
      },
    };
    const commander = await readCommander(commanderClient, commanderActivityFile, services);
    const system = {
      services,
      alerts: 0,
      legacyRdcDisabled: services.legacyRdc?.activeState !== 'active',
      secureTunnelDisabled: services.secureTunnel?.activeState !== 'active',
      generatedAt: Date.now(),
    };
    system.alerts = systemAlerts({ commander, autopilot, services });

    return {
      ok: true,
      version: 4,
      mode: 'project-control',
      generatedAt: system.generatedAt,
      commander,
      autopilot,
      system,
      // Backward-compatible v3 fields used by existing clients/tests.
      aiCalls: 0,
      controlApi: { online: Boolean(controlHealth), localOnly: true },
      githubWebhook: autopilot.githubWebhook,
      telegramBridge: autopilot.telegramBridge,
      projects,
    };
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname.replace(/^\/autopilot(?=\/|$)/, '') || '/';

      if (req.method === 'GET' && pathname === '/health') {
        return send(res, 200, { ok: true, version: 4, mode: 'project-control', aiCalls: 0 });
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
