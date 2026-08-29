import { loadDotEnv } from "./env.mjs";
import { loadRuntimeConfig } from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { TelegramNotifier } from "./notifier.mjs";

loadDotEnv();
const config = loadRuntimeConfig();
const logger = createLogger(config.logDir);
const notifier = new TelegramNotifier({
  token: config.telegramBotToken,
  chatId: config.telegramChatId,
  logger
});

if (!notifier.enabled) {
  console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env first.");
  process.exit(2);
}

const ok = await notifier.send("✅ ChatGPT Project Autopilot: Telegram notifications work.");
process.exit(ok ? 0 : 1);
