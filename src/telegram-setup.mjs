import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadDotEnv } from "./env.mjs";
import { selectLatestPrivateChat, writeEnvAtomic } from "./telegram-setup-lib.mjs";
import { TELEGRAM_TEST_MESSAGE } from "./messages.uk.mjs";

const ENV_FILE = path.resolve(process.cwd(), ".env");

function secretPrompt(label) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Налаштування Telegram потребує інтерактивного термінала");
  }
  output.write(label);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          cleanup();
          reject(new Error("Налаштування скасовано"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
  });
}

async function telegram(token, method, body = undefined) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) {
    throw new Error(`Помилка Telegram ${method}: ${payload.description || `HTTP ${response.status}`}`);
  }
  return payload.result;
}

async function waitForEnter(message) {
  const rl = readline.createInterface({ input, output });
  try { await rl.question(`${message}\nНатисніть Enter, коли виконаєте цю дію... `); }
  finally { rl.close(); }
}

async function discoverChat(token, botUsername) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const updates = await telegram(token, "getUpdates");
    const chat = selectLatestPrivateChat(updates);
    if (chat) return chat;
    if (attempt === 0) {
      await waitForEnter(`Відкрийте @${botUsername} у Telegram і надішліть /start.`);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw new Error("Приватний чат Telegram не знайдено. Надішліть /start боту та запустіть налаштування ще раз.");
}

loadDotEnv(ENV_FILE);
const existingToken = process.env.TELEGRAM_BOT_TOKEN || "";
const entered = await secretPrompt(existingToken
  ? "Токен Telegram-бота (Enter — залишити поточний токен): "
  : "Токен Telegram-бота: ");
const token = entered || existingToken;
if (!token) throw new Error("Потрібен токен Telegram-бота");
if (/\s/.test(token)) throw new Error("Токен Telegram-бота містить пробіли");

const me = await telegram(token, "getMe");
const botUsername = String(me.username || "");
if (!botUsername) throw new Error("Telegram не повернув username бота");
console.log(`Бота підтверджено: @${botUsername}`);

const chat = await discoverChat(token, botUsername);
const current = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
writeEnvAtomic(ENV_FILE, current, {
  TELEGRAM_BOT_TOKEN: token,
  TELEGRAM_CHAT_ID: chat.chatId
});
console.log("Дані Telegram збережено локально у .env з правами 0600.");

await telegram(token, "sendMessage", {
  chat_id: chat.chatId,
  text: TELEGRAM_TEST_MESSAGE,
  disable_web_page_preview: true
});
console.log("Тестове сповіщення успішно доставлено.");
console.log("Перезапустіть користувацький сервіс Autopilot, щоб він перечитав .env:");
console.log("  systemctl --user restart chatgpt-project-autopilot");
