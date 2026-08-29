import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_EVENTS, eventMessage } from "../src/bridge.mjs";

const project = { id: "demo", name: "Demo", chatUrl: "https://chatgpt.com/c/abc" };

test("bridge notification surface is fixed and notification-only", () => {
  assert.deepEqual([...ALLOWED_EVENTS].sort(), [
    "AUTOMATION_ERROR",
    "RECOVERED",
    "SESSION_ATTENTION_REQUIRED",
    "USER_ACTION_REQUIRED"
  ]);
});

test("event messages contain project identity but no arbitrary payload", () => {
  const text = eventMessage(project, "USER_ACTION_REQUIRED");
  assert.match(text, /Demo/);
  assert.match(text, /https:\/\/chatgpt\.com\/c\/abc/);
  assert.throws(() => eventMessage(project, "RUN_SHELL"));
});
