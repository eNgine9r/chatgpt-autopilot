import { loadDotEnv } from "./env.mjs";
loadDotEnv();

const token = process.env.TELEGRAM_BOT_TOKEN || "";
const owner = process.env.TELEGRAM_OWNER_USER_ID || (Number(process.env.TELEGRAM_CHAT_ID) > 0 ? process.env.TELEGRAM_CHAT_ID : "");
const url = process.env.TELEGRAM_MINIAPP_URL || "";
if (!token || !owner || !/^https:\/\//.test(url)) {
  throw new Error("TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_USER_ID and HTTPS TELEGRAM_MINIAPP_URL are required");
}

async function call(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`${method}: ${data.description || response.status}`);
  return data.result;
}

await call("setChatMenuButton", {
  chat_id: owner,
  menu_button: { type: "web_app", text: "Autopilot", web_app: { url } }
});
console.log("Telegram Mini App menu button configured for the owner chat.");
