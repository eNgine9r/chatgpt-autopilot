import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCodexState, saveCodexState } from "../src/codex-state-store.mjs";

test("persists Codex thread state atomically with private permissions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-codex-state-"));
  const file = saveCodexState(dir, "nexolab", { threadId: "thr_test" });
  assert.deepEqual(loadCodexState(dir, "nexolab"), { threadId: "thr_test" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("missing Codex state returns an empty object", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-codex-state-"));
  assert.deepEqual(loadCodexState(dir, "missing"), {});
});
