import fs from "node:fs";
import path from "node:path";

function validateEnvValue(value, key) {
  const text = String(value ?? "");
  if (!text || /[\r\n]/.test(text)) throw new Error(`${key} must be a single non-empty line`);
  return text;
}

export function upsertEnvText(source, updates) {
  const values = new Map(
    Object.entries(updates).map(([key, value]) => [key, validateEnvValue(value, key)])
  );
  const seen = new Set();
  const lines = String(source || "").split(/\r?\n/);
  const output = [];

  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)=/);
    const key = match?.[1];
    if (key && values.has(key)) {
      if (!seen.has(key)) {
        output.push(`${key}=${values.get(key)}`);
        seen.add(key);
      }
      continue;
    }
    if (line !== "" || output.length) output.push(line);
  }

  while (output.length && output[output.length - 1] === "") output.pop();
  for (const [key, value] of values) {
    if (!seen.has(key)) output.push(`${key}=${value}`);
  }
  return `${output.join("\n")}\n`;
}

export function selectLatestPrivateChat(updates) {
  const candidates = [];
  for (const update of Array.isArray(updates) ? updates : []) {
    const message = update?.message || update?.edited_message || null;
    const chat = message?.chat;
    if (chat?.type !== "private" || chat.id == null) continue;
    candidates.push({
      updateId: Number(update.update_id || 0),
      chatId: String(chat.id),
      username: chat.username ? String(chat.username) : "",
      firstName: chat.first_name ? String(chat.first_name) : ""
    });
  }
  candidates.sort((a, b) => b.updateId - a.updateId);
  return candidates[0] || null;
}

export function writeEnvAtomic(file, source, updates) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, upsertEnvText(source, updates), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
}
