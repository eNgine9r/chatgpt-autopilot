import path from 'node:path';
import { loadDotEnv } from '../env.mjs';
import { loadConfig } from './config.mjs';
import { JsonStateStore } from './store.mjs';
import { createMiniAppServer } from './miniapp-server.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
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
  githubWebhook: true,
  staticDir: path.resolve('web/miniapp'),
});

server.listen(port, '127.0.0.1', () => {
  console.log(`autopilot-v3 miniapp listening http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
