import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../extension/adaptive-scheduling-policy.js", import.meta.url), "utf8");
const context = { globalThis: {} };
vm.runInNewContext(source, context);
const Policy = context.globalThis.AutopilotAdaptiveSchedulingPolicy;

test("mirror audit backs off after repeated same results and resets after refresh", () => {
  const first = Policy.nextMirrorAudit({ result:"same", now:1_000, sameStreak:0, baseMs:100, maxMs:800 });
  assert.equal(first.sameStreak, 1);
  assert.equal(first.nextAuditAt, 1_200);
  const second = Policy.nextMirrorAudit({ result:"same", now:1_200, sameStreak:first.sameStreak, baseMs:100, maxMs:800 });
  assert.equal(second.sameStreak, 2);
  assert.equal(second.nextAuditAt, 1_600);
  const capped = Policy.nextMirrorAudit({ result:"same", now:2_000, sameStreak:8, baseMs:100, maxMs:800 });
  assert.equal(capped.nextAuditAt, 2_800);
  const reset = Policy.nextMirrorAudit({ result:"refresh", now:3_000, sameStreak:5, baseMs:100, maxMs:800 });
  assert.equal(reset.sameStreak, 0);
  assert.equal(reset.nextAuditAt, 3_100);
});

test("initial mirror audit waits from monitor start instead of navigating immediately", () => {
  assert.equal(Policy.initialMirrorAuditAt({ monitorStartedAt:10_000, baseMs:900 }), 10_900);
  assert.equal(Policy.initialMirrorAuditAt({ monitorStartedAt:10_000, lastProbeAt:20_000, baseMs:900 }), 20_900);
  assert.equal(Policy.initialMirrorAuditAt({ monitorStartedAt:10_000, lastProbeAt:20_000, nextAuditAt:40_000, baseMs:900 }), 40_000);
});

test("full discovery is reserved for forced or infrequent inconclusive audits", () => {
  assert.equal(Policy.shouldUseFullDiscovery({ forced:false, inPlaceConclusive:true, now:100_000, lastFullScanAt:0, fullAuditMs:10 }), false);
  assert.equal(Policy.shouldUseFullDiscovery({ forced:true, inPlaceConclusive:true, now:100_000, lastFullScanAt:99_999, fullAuditMs:10_000 }), true);
  assert.equal(Policy.shouldUseFullDiscovery({ forced:false, inPlaceConclusive:false, now:100_000, lastFullScanAt:95_000, fullAuditMs:10_000 }), false);
  assert.equal(Policy.shouldUseFullDiscovery({ forced:false, inPlaceConclusive:false, now:100_000, lastFullScanAt:80_000, fullAuditMs:10_000 }), true);
});

test("recovery cooldown escalates and caps", () => {
  const schedule = [5,15,30];
  assert.equal(Policy.recoveryCooldownMs({ failures:1, schedule }), 5);
  assert.equal(Policy.recoveryCooldownMs({ failures:2, schedule }), 15);
  assert.equal(Policy.recoveryCooldownMs({ failures:3, schedule }), 30);
  assert.equal(Policy.recoveryCooldownMs({ failures:10, schedule }), 30);
});
