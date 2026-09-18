import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { commanderPublicClientFromEnv } from '../commander/client/client.mjs';
import { commanderActivityFile } from '../commander/activity-store.mjs';
import { loadDotEnv } from '../env.mjs';
import { loadConfig } from './config.mjs';
import { JsonStateStore } from './store.mjs';
import { createMiniAppServer } from './miniapp-server.mjs';

const execFileAsync = promisify(execFile);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function userSystemdEnv() {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid)) return process.env;
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus`,
  };
}

async function userServiceStatus(unit) {
  const { stdout } = await execFileAsync('/usr/bin/systemctl', [
    '--user', 'show', unit,
    '--property=LoadState',
    '--property=ActiveState',
    '--property=SubState',
    '--property=UnitFileState',
    '--property=MainPID',
  ], {
    encoding: 'utf8',
    timeout: 1200,
    maxBuffer: 16 * 1024,
    env: userSystemdEnv(),
  });
  const values = {};
  for (const line of String(stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) values[line.slice(0, i)] = line.slice(i + 1);
  }
  return {
    unit,
    loadState: values.LoadState || 'unknown',
    activeState: values.ActiveState || 'unknown',
    subState: values.SubState || 'unknown',
    unitFileState: values.UnitFileState || 'unknown',
    mainPid: Number(values.MainPID || 0),
  };
}

const envFile = arg('--env', '.env');
const configFile = arg('--config', 'config/v3-projects.json');
const stateDir = arg('--state-dir', 'state-v3');
const port = Number(arg('--port', process.env.AUTOPILOT_V3_MINIAPP_PORT ?? '8782'));
const controlPort = Number(arg('--control-port', process.env.AUTOPILOT_V3_PORT ?? '8780'));
loadDotEnv(envFile);

const botToken = String(process.env.TELEGRAM_BOT_TOKEN ?? '');
const ownerUserId = String(process.env.TELEGRAM_OWNER_USER_ID ?? '');
if (botToken.length < 20 || botToken.length > 200 || /\s/.test(botToken)) throw new Error('invalid_telegram_token');
if (!/^\d+$/.test(ownerUserId)) throw new Error('invalid_telegram_owner');
const config = await loadConfig(configFile);
const store = new JsonStateStore(stateDir);
await store.init();

const server = createMiniAppServer({
  config,
  store,
  botToken,
  ownerUserId,
  controlBaseUrl: `http://127.0.0.1:${controlPort}`,
  telegramStateFile: path.join(stateDir, 'telegram.json'),
  commanderClient: commanderPublicClientFromEnv(process.env),
  commanderActivityFile: commanderActivityFile(process.env),
  serviceStatusReader: userServiceStatus,
  staticDir: path.resolve('web/miniapp'),
});

server.listen(port, '127.0.0.1', () => {
  console.log(`project-control miniapp listening http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
