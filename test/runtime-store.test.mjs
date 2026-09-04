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
