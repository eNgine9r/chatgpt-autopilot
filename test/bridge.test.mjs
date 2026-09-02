import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_EVENTS, eventMessage } from "../src/bridge.mjs";

const project = { id: "demo", name: "Демонстрація", chatUrl: "https://chatgpt.com/c/abc" };

test("bridge notification surface is fixed and notification-only", () => {
  assert.deepEqual([...ALLOWED_EVENTS].sort(), [
    "AUTOMATION_ERROR",
    "AUTOMATION_STALLED",
    "CONVERSATION_ROLLED_OVER",
    "RECOVERED",
    "SESSION_ATTENTION_REQUIRED",
    "USER_ACTION_REQUIRED"
  ]);
});

test("event messages are Ukrainian and contain project identity", () => {
  const action = eventMessage(project, "USER_ACTION_REQUIRED");
  assert.match(action, /Демонстрація/);
  assert.match(action, /потрібна ваша дія/);
  assert.match(action, /Автопродовження призупинено/);
  assert.match(action, /https:\/\/chatgpt\.com\/c\/abc/);

  assert.match(eventMessage(project, "SESSION_ATTENTION_REQUIRED"), /сесія ChatGPT потребує уваги/);
  assert.match(eventMessage(project, "AUTOMATION_ERROR"), /інтерфейс ChatGPT/);
  assert.match(eventMessage(project, "RECOVERED"), /відновив безпечну роботу/);
  assert.match(eventMessage(project, "CONVERSATION_ROLLED_OVER"), /максимальної довжини/);
  assert.throws(() => eventMessage(project, "RUN_SHELL"), /Непідтримувана подія/);
});
