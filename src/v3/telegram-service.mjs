import { loadDotEnv } from '../env.mjs';
import { loadConfig } from './config.mjs';
import { TelegramBridge, TelegramBridgeStateStore } from './telegram-bridge.mjs';
import { createLocalV3Client, createTelegramClient } from './telegram-clients.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const envFile = arg('--env', '.env');
const configFile = arg('--config', 'config/v3-projects.json');
const stateFile = arg('--state-file', 'state-v3/telegram.json');
loadDotEnv(envFile);

const token = String(process.env.TELEGRAM_BOT_TOKEN ?? '');
const chatId = String(process.env.TELEGRAM_CHAT_ID ?? '');
const ownerUserId = String(process.env.TELEGRAM_OWNER_USER_ID ?? '');
if (token.length < 20 || token.length > 200 || /\s/.test(token)) {
  throw new Error('invalid_telegram_token');
}
if (!/^-?\d+$/.test(chatId) || !/^\d+$/.test(ownerUserId)) {
  throw new Error('invalid_telegram_owner');
}

const config = await loadConfig(configFile);
const store = new TelegramBridgeStateStore(stateFile);
const telegram = createTelegramClient({ token });
const localApi = createLocalV3Client();
const bridge = new TelegramBridge({
  config,
  store,
  telegram,
  localApi,
  ownerUserId,
  chatId,
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stopping = true; });
}

console.log('autopilot-v3 telegram bridge started');
while (!stopping) {
  try {
    await bridge.scanStates();
    const state = await store.load();
    const updates = await telegram.getUpdates(state.offset);
    await bridge.processUpdates(updates);
    await bridge.scanStates();
  } catch (error) {
    console.error(`telegram_bridge_error:${String(error?.message ?? error).slice(0, 500)}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
