import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../extension/maintenance-policy.js", import.meta.url), "utf8");
const context = { globalThis: {} };
vm.runInNewContext(source, context);
const Policy = context.globalThis.AutopilotMaintenancePolicy;

test("heartbeat fallback is throttled and overlap-safe", () => {
  assert.equal(Policy.shouldRun({ running: true, lastStartedAt: 0, now: 20000 }), false);
  assert.equal(Policy.shouldRun({ lastStartedAt: 10000, now: 20000, minIntervalMs: 15000 }), false);
  assert.equal(Policy.shouldRun({ lastStartedAt: 10000, now: 25000, minIntervalMs: 15000 }), true);
});

test("alarm or startup force bypasses throttle but not an active run", () => {
  assert.equal(Policy.shouldRun({ running: false, lastStartedAt: 24000, now: 25000, force: true }), true);
  assert.equal(Policy.shouldRun({ running: true, lastStartedAt: 24000, now: 25000, force: true }), false);
});

test("snapshot exposes bounded scheduler health fields", () => {
  const value = Policy.snapshot({ running: true, lastStartedAt: 10, lastCompletedAt: 9, lastSource: "heartbeat", consecutiveFailures: 2 });
  assert.equal(value.schedulerLastStartedAt, 10);
  assert.equal(value.schedulerLastCompletedAt, 9);
  assert.equal(value.schedulerLastSource, "heartbeat");
  assert.equal(value.schedulerRunning, true);
  assert.equal(value.schedulerConsecutiveFailures, 2);
});


test("v21 routes alarm, heartbeat, and tab activity through one maintenance gate", () => {
  const worker = fs.readFileSync(new URL("../extension/service-worker-v21.js", import.meta.url), "utf8");
  assert.match(worker, /runMaintenance\(\{ source: "heartbeat" \}\)/);
  assert.match(worker, /runMaintenance\(\{ source: "alarm", sendPulse: true, force: true \}\)/);
  assert.match(worker, /runMaintenance\(\{ source: "tab_updated", force: true \}\)/);
  assert.match(worker, /runMaintenance\(\{ source: "tab_removed", force: true \}\)/);
  assert.match(worker, /startMaintenance\("service_worker_start"\)/);
});
