import { loadDotEnv } from "./env.mjs";
import { loadRuntimeConfig } from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { TelegramNotifier } from "./notifier.mjs";
import { TELEGRAM_TEST_MESSAGE } from "./messages.uk.mjs";

loadDotEnv();
const config = loadRuntimeConfig();
const logger = createLogger(config.logDir);
const notifier = new TelegramNotifier({
  token: config.telegramBotToken,
  chatId: config.telegramChatId,
  logger
});

if (!notifier.enabled) {
  console.error("Спочатку задайте TELEGRAM_BOT_TOKEN і TELEGRAM_CHAT_ID у файлі .env.");
  process.exit(2);
}

const ok = await notifier.send(TELEGRAM_TEST_MESSAGE);
process.exit(ok ? 0 : 1);
