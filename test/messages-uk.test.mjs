import test from "node:test";
import assert from "node:assert/strict";
import {
  TELEGRAM_BOT_PROFILE_UK,
  TELEGRAM_TEST_MESSAGE,
  telegramEventMessage
} from "../src/messages.uk.mjs";

const project = {
  name: "Розробка Autopilot",
  chatUrl: "https://chatgpt.com/c/demo"
};

test("Telegram test message is Ukrainian", () => {
  assert.match(TELEGRAM_TEST_MESSAGE, /сповіщення Telegram працюють/);
});

test("Ukrainian bot profile fits Telegram limits", () => {
  assert.ok(TELEGRAM_BOT_PROFILE_UK.name.length <= 64);
  assert.ok(TELEGRAM_BOT_PROFILE_UK.shortDescription.length <= 120);
  assert.ok(TELEGRAM_BOT_PROFILE_UK.description.length <= 512);
  assert.match(TELEGRAM_BOT_PROFILE_UK.shortDescription, /потрібна ваша дія/);
  assert.match(TELEGRAM_BOT_PROFILE_UK.description, /лише для сповіщень/);
});

test("all supported notification events have Ukrainian user-facing text", () => {
  const events = [
    "USER_ACTION_REQUIRED",
    "SESSION_ATTENTION_REQUIRED",
    "AUTOMATION_ERROR",
    "AUTOMATION_STALLED",
    "RECOVERED"
  ];
  for (const event of events) {
    const text = telegramEventMessage(project, event);
    assert.match(text, /Розробка Autopilot/);
    assert.doesNotMatch(text, /Auto-Continue|notifications work|requires attention/);
  }
});
