import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearStartupAlert,
  normalizeStartupError,
  shouldSendStartupAlert
} from "../src/startup-alert-dedupe.mjs";

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-alert-dedupe-"));
}

test("normalizes volatile thread identifiers", () => {
  const a = normalizeStartupError("Error: no rollout found for thread id 01a0660f-254c-7932-a575-c793c42fe722");
  const b = normalizeStartupError("Error: no rollout found for thread id 01b1771a-1111-2222-3333-444444444444");
  assert.equal(a, b);
});

test("first alert sends and identical restart alert is suppressed", () => {
  const dir = fixture();
  let now = 1_000;
  const opts = { now: () => now, cooldownMs: 60_000 };
  assert.equal(shouldSendStartupAlert(dir, "demo", "Error: failed", opts), true);
  now += 5_000;
  assert.equal(shouldSendStartupAlert(dir, "demo", "Error: failed", opts), false);
  assert.equal(fs.statSync(path.join(dir, "demo.startup-alert.json")).mode & 0o777, 0o600);
});
test("changed error bypasses cooldown", () => {
  const dir = fixture();
  const opts = { now: () => 10_000, cooldownMs: 60_000 };
  assert.equal(shouldSendStartupAlert(dir, "demo", "Error: one", opts), true);
  assert.equal(shouldSendStartupAlert(dir, "demo", "Error: two", opts), true);
});

test("cooldown expiry allows a reminder", () => {
  const dir = fixture();
  let now = 10_000;
  const opts = { now: () => now, cooldownMs: 60_000 };
  assert.equal(shouldSendStartupAlert(dir, "demo", "Error: failed", opts), true);
  now += 60_001;
  assert.equal(shouldSendStartupAlert(dir, "demo", "Error: failed", opts), true);
});

test("successful recovery clears the persistent latch", () => {
  const dir = fixture();
  const opts = { now: () => 10_000, cooldownMs: 60_000 };
  assert.equal(shouldSendStartupAlert(dir, "demo", "Error: failed", opts), true);
  clearStartupAlert(dir, "demo");
  assert.equal(shouldSendStartupAlert(dir, "demo", "Error: failed", opts), true);
});
