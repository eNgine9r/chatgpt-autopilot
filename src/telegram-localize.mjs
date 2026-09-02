import { loadDotEnv } from "./env.mjs";
import { TELEGRAM_BOT_PROFILE_UK } from "./messages.uk.mjs";

loadDotEnv();
const token = process.env.TELEGRAM_BOT_TOKEN || "";
if (!token) throw new Error("У .env не задано TELEGRAM_BOT_TOKEN");
if (/\s/.test(token)) throw new Error("TELEGRAM_BOT_TOKEN містить пробіли");

const profile = TELEGRAM_BOT_PROFILE_UK;
if (profile.name.length > 64) throw new Error("Назва Telegram-бота перевищує 64 символи");
if (profile.shortDescription.length > 120) throw new Error("Короткий опис Telegram-бота перевищує 120 символів");
if (profile.description.length > 512) throw new Error("Опис Telegram-бота перевищує 512 символів");

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) {
    throw new Error(`Помилка Telegram ${method}: ${payload.description || `HTTP ${response.status}`}`);
  }
  return payload.result;
}

const variants = [undefined, "uk"];
for (const languageCode of variants) {
  const language = languageCode ? { language_code: languageCode } : {};
  await telegram("setMyName", { name: profile.name, ...language });
  await telegram("setMyShortDescription", {
    short_description: profile.shortDescription,
    ...language
  });
  await telegram("setMyDescription", {
    description: profile.description,
    ...language
  });
}

console.log("✅ Назву Telegram-бота українізовано.");
console.log("✅ Короткий опис Telegram-бота українізовано.");
console.log("✅ Повний опис Telegram-бота українізовано.");
