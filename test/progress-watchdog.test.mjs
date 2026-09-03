import test from "node:test";
import assert from "node:assert/strict";
import { SupervisorProgressWatchdog } from "../src/progress-watchdog.mjs";

function fixture() {
  let now = 1_000_000;
  const sent = [];
  const logs = [];
  const project = {
    id: "demo",
    name: "Demo",
    enabled: true,
    chatUrl: "https://chatgpt.com/c/demo",
    noProgressAlertSeconds: 1800
  };
  const watchdog = new SupervisorProgressWatchdog({
    projects: [project],
    notifier: { send: async (text) => { sent.push(text); return true; } },
    logger: { info: (message, data) => logs.push({ message, data }) },
    now: () => now
  });
  return { watchdog, sent, logs, setNow: (value) => { now = value; }, project };
}

test("meaningful progress resets the no-progress clock", async () => {
  const f = fixture();
  f.watchdog.observe("demo", { progressKey: "a", status: "working" });
  f.setNow(1_000_000 + 20 * 60_000);
  f.watchdog.observe("demo", { progressKey: "b", status: "working" });
  f.setNow(1_000_000 + 40 * 60_000);
  await f.watchdog.check();
  assert.equal(f.sent.length, 0);
});

test("30 minutes without meaningful progress sends one alert", async () => {
  const f = fixture();
  f.watchdog.observe("demo", { progressKey: "a", status: "working" });
  f.setNow(1_000_000 + 30 * 60_000);
  f.watchdog.observe("demo", { progressKey: "a", status: "working" });
  await f.watchdog.check();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /понад 30 хв немає прогресу/);
  f.setNow(1_000_000 + 45 * 60_000);
  await f.watchdog.check();
  assert.equal(f.sent.length, 1);
});

test("missing heartbeat sends one independent supervisor alert", async () => {
  const f = fixture();
  f.watchdog.observe("demo", { progressKey: "a", status: "working" });
  f.setNow(1_000_000 + 31 * 60_000);
  await f.watchdog.check();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /heartbeat/);
});

test("progress recovery clears the latch for a later stall episode", async () => {
  const f = fixture();
  f.watchdog.observe("demo", { progressKey: "a" });
  f.setNow(1_000_000 + 31 * 60_000);
  await f.watchdog.check();
  assert.equal(f.sent.length, 1);
  f.watchdog.observe("demo", { progressKey: "b", status: "working" });
  f.setNow(1_000_000 + 62 * 60_000);
  f.watchdog.observe("demo", { progressKey: "b", status: "working" });
  await f.watchdog.check();
  assert.equal(f.sent.length, 2);
  assert.ok(f.logs.some((entry) => entry.message === "supervisor_progress_recovered"));
});

test("legacy extension stall event shares the same dedupe latch", async () => {
  const f = fixture();
  await f.watchdog.notifyStall("demo", "extension_watchdog");
  await f.watchdog.notifyStall("demo", "no_progress");
  assert.equal(f.sent.length, 1);
});


test("watchdog opt-out suppresses scheduled and explicit stall alerts", async () => {
  const f = fixture();
  f.project.watchdogEnabled = false;
  const watchdog = new SupervisorProgressWatchdog({
    projects: [f.project],
    notifier: { send: async (text) => { f.sent.push(text); return true; } },
    logger: { info: (message, data) => f.logs.push({ message, data }) },
    now: () => 1_000_000 + 24 * 60 * 60_000
  });
  watchdog.observe("demo", { progressKey: "idle", status: "idle" });
  await watchdog.check();
  const explicit = await watchdog.notifyStall("demo", "no_progress");
  assert.equal(f.sent.length, 0);
  assert.equal(explicit.disabled, true);
});
