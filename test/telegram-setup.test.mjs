import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  selectLatestPrivateChat,
  upsertEnvText,
  writeEnvAtomic
} from "../src/telegram-setup-lib.mjs";

test("upsertEnvText replaces target keys, removes duplicates and preserves unrelated settings", () => {
  const source = [
    "DISPLAY=:0",
    "TELEGRAM_BOT_TOKEN=old-one",
    "OTHER=value",
    "TELEGRAM_BOT_TOKEN=old-two",
    "TELEGRAM_CHAT_ID=old-chat",
    ""
  ].join("\n");
  const result = upsertEnvText(source, {
    TELEGRAM_BOT_TOKEN: "new:token",
    TELEGRAM_CHAT_ID: "12345"
  });
  assert.match(result, /^DISPLAY=:0$/m);
  assert.match(result, /^OTHER=value$/m);
  assert.match(result, /^TELEGRAM_BOT_TOKEN=new:token$/m);
  assert.match(result, /^TELEGRAM_CHAT_ID=12345$/m);
  assert.equal((result.match(/TELEGRAM_BOT_TOKEN=/g) || []).length, 1);
  assert.equal((result.match(/TELEGRAM_CHAT_ID=/g) || []).length, 1);
  assert.doesNotMatch(result, /old-one|old-two|old-chat/);
});

test("selectLatestPrivateChat chooses the newest private message", () => {
  const selected = selectLatestPrivateChat([
    { update_id: 10, message: { chat: { id: 1, type: "group" } } },
    { update_id: 11, message: { chat: { id: 22, type: "private", username: "older" } } },
    { update_id: 19, message: { chat: { id: 33, type: "private", username: "latest" } } }
  ]);
  assert.deepEqual(selected, {
    updateId: 19,
    chatId: "33",
    username: "latest",
    firstName: ""
  });
});

test("writeEnvAtomic keeps private file permissions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-tg-"));
  const file = path.join(dir, ".env");
  try {
    writeEnvAtomic(file, "DISPLAY=:0\n", {
      TELEGRAM_BOT_TOKEN: "abc:def",
      TELEGRAM_CHAT_ID: "42"
    });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /^TELEGRAM_CHAT_ID=42$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
