import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state.mjs";

test("state writes are change-driven", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-state-"));
  const store = new StateStore(dir);
  store.set("p1", { status: "armed", dueAtMs: 123 });
  const stat1 = fs.statSync(path.join(dir, "runtime-state.json"));
  const content1 = fs.readFileSync(path.join(dir, "runtime-state.json"), "utf8");

  store.set("p1", { status: "armed", dueAtMs: 123 });
  const stat2 = fs.statSync(path.join(dir, "runtime-state.json"));
  const content2 = fs.readFileSync(path.join(dir, "runtime-state.json"), "utf8");

  assert.equal(content2, content1);
  assert.equal(stat2.size, stat1.size);
  fs.rmSync(dir, { recursive: true, force: true });
});
