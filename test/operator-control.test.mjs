import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectRuntimeStore } from "../src/runtime-store.mjs";
import { applyOperatorAction, isOperatorProjectProvenIdle, operatorProjectStatus } from "../src/operator-control.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-operator-"));
  const project = { id: "demo", name: "Demo", chatUrl: "https://chatgpt.com/c/demo", chatDiscovery: { enabled: true } };
  const store = new ProjectRuntimeStore({ stateDir: root, projects: [project], now: () => 100000 });
  return { project, store };
}

test("operator actions share one durable policy", () => {
  const { project, store } = fixture();
  assert.equal(applyOperatorAction(project, store, "pause").state.control.paused, true);
  assert.equal(applyOperatorAction(project, store, "resume").state.control.paused, false);
  assert.equal(applyOperatorAction(project, store, "restart").state.control.restartGeneration, 1);
  assert.equal(applyOperatorAction(project, store, "rollover").state.control.rolloverGeneration, 1);
  assert.equal(applyOperatorAction(project, store, "scan_chats").state.control.discoveryScanGeneration, 1);
  assert.equal(applyOperatorAction(project, store, "adopt_candidate").error, "no_discovery_candidate");
});
test("proven idle requires a fresh explicit idle heartbeat", () => {
  const { project, store } = fixture();
  store.observe(project.id, { progressKey: "assistant|turn|finished|idle|abc", status: "assistant" });
  const status = operatorProjectStatus(project, store, { snapshot: () => ({ alerted: false }) });
  assert.equal(isOperatorProjectProvenIdle(status, 100000), true);
  assert.equal(isOperatorProjectProvenIdle({ ...status, worker: { online: false } }, 100000), false);
  assert.equal(isOperatorProjectProvenIdle({ ...status, state: { ...status.state, runtime: { ...status.state.runtime, progressKey: "assistant|turn|unknown|generating|abc", status: "working" } } }, 100000), false);
  assert.equal(isOperatorProjectProvenIdle(status, 131000), false);
});
