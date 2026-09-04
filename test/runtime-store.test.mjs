import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectRuntimeStore } from "../src/runtime-store.mjs";

function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-state-"));
  let now = 1000;
  const store = new ProjectRuntimeStore({ stateDir, projects: [{ id: "demo" }], now: () => now });
  return { store, stateDir, tick: (value) => { now = value; } };
}

test("operator controls persist across store instances", () => {
  const { store, stateDir } = fixture();
  store.setPaused("demo", true);
  store.bump("demo", "restartGeneration");
  const reloaded = new ProjectRuntimeStore({ stateDir, projects: [{ id: "demo" }] });
  assert.equal(reloaded.control("demo").paused, true);
  assert.equal(reloaded.control("demo").restartGeneration, 1);
});

test("heartbeat stores bounded durable checkpoint only on meaningful changes", () => {
  const { store, tick } = fixture();
  const first = store.observe("demo", { progressKey: "a", status: "working", latestAssistantExcerpt: "x".repeat(4000) });
  assert.equal(first.changed, true);
  assert.equal(first.state.runtime.latestAssistantExcerpt.length, 3000);
  tick(2000);
  const same = store.observe("demo", { progressKey: "a", status: "working" });
  assert.equal(same.changed, false);
  tick(20000);
  const periodic = store.observe("demo", { progressKey: "a", status: "assistant" });
  assert.equal(periodic.state.runtime.status, "assistant");
});

test("discovery candidate and adoption history persist durably", () => {
  const { store, stateDir, tick } = fixture();
  store.recordDiscovery("demo", { url: "https://chatgpt.com/g/g-p-demo/c/new", title: "New chat", preview: "preview" }, { eligible: true, reason: "pattern" });
  let state = store.snapshot("demo");
  assert.equal(state.discovery.candidateEligible, true);
  assert.equal(state.discovery.candidateReason, "pattern");
  tick(3000);
  store.recordAdoption("demo", { url: state.discovery.candidateUrl, title: state.discovery.candidateTitle, mode: "manual" });
  const reloaded = new ProjectRuntimeStore({ stateDir, projects: [{ id: "demo" }] });
  state = reloaded.snapshot("demo");
  assert.equal(state.discovery.candidateUrl, "");
  assert.equal(state.discovery.lastAdoptedTitle, "New chat");
  assert.equal(state.discovery.lastAdoptionMode, "manual");
  assert.equal(state.discovery.lastAdoptedAt, 3000);
});

test("browser recovery stage and cooldown persist across supervisor restarts", () => {
  const { store, stateDir, tick } = fixture();
  store.recordRecovery("demo", { stage:"soft_reload", reason:"composer_missing", attempts:1, softReloads:1, nextCheckAt:46000 });
  let reloaded = new ProjectRuntimeStore({ stateDir, projects: [{ id:"demo" }] });
  assert.equal(reloaded.snapshot("demo").recovery.stage, "soft_reload");
  assert.equal(reloaded.snapshot("demo").recovery.softReloads, 1);
  tick(50000);
  store.recordRecovery("demo", { stage:"failed", alerted:true, cooldownUntil:350000 });
  reloaded = new ProjectRuntimeStore({ stateDir, projects: [{ id:"demo" }] });
  assert.equal(reloaded.snapshot("demo").recovery.alerted, true);
  assert.equal(reloaded.snapshot("demo").recovery.cooldownUntil, 350000);
});

test("successful browser recovery clears episode counters", () => {
  const { store, tick } = fixture();
  store.recordRecovery("demo", { stage:"tab_recreate", attempts:2, tabRecreates:1, alerted:true });
  tick(9000);
  const state = store.clearRecovery("demo");
  assert.equal(state.recovery.stage, "idle");
  assert.equal(state.recovery.attempts, 0);
  assert.equal(state.recovery.alerted, false);
  assert.equal(state.recovery.lastRecoveredAt, 9000);
});
