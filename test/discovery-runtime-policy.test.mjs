import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../extension/discovery-runtime-policy.js", import.meta.url), "utf8");
const context = { globalThis: {} };
vm.runInNewContext(source, context);
const Policy = context.globalThis.AutopilotDiscoveryRuntimePolicy;

test("discovery runtime snapshot is bounded and generation-aware", () => {
  const value = Policy.snapshot({
    gate: "source_status_unavailable",
    controlGeneration: 6,
    scanGeneration: 5,
    pending: false,
    updatedAt: 1234
  });
  assert.equal(value.discoverySchedulerGate, "source_status_unavailable");
  assert.equal(value.discoverySchedulerControlGeneration, 6);
  assert.equal(value.discoverySchedulerScanGeneration, 5);
  assert.equal(value.discoverySchedulerPending, false);
  assert.equal(value.discoverySchedulerUpdatedAt, 1234);
});

test("unknown discovery gates fail closed to idle and invalid numbers clamp to zero", () => {
  const value = Policy.state({ gate: "raw_dom_reason", controlGeneration: -2, scanGeneration: "nope" });
  assert.equal(value.gate, "idle");
  assert.equal(value.controlGeneration, 0);
  assert.equal(value.scanGeneration, 0);
});

test("current worker records bounded discovery gates before navigation", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  const worker = fs.readFileSync(new URL(`../extension/${manifest.background.service_worker}`, import.meta.url), "utf8");
  assert.match(worker, /DISCOVERY_DIAGNOSTIC_PREFIX = "discovery-diagnostic:"/);
  assert.match(worker, /gate: "no_source_tab"/);
  assert.match(worker, /gate: "source_status_unavailable"/);
  assert.match(worker, /gate: status\.generating \? "generation_active" : "policy_wait"/);
  assert.match(worker, /gate: "navigation_denied"/);
  assert.match(worker, /gate: "started"/);
  assert.match(worker, /discoveryDiagnosticSnapshot\(message\.projectId\)/);
});
