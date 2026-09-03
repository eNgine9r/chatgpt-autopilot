import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findNewPromptPids,
  listOwnedGcrPrompterPids,
  watchAndDismissNewGcrPrompters
} from "../src/keyring-prompt.mjs";

function fakeProcEntry(root, pid, comm, uid) {
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "comm"), `${comm}\n`);
  fs.writeFileSync(path.join(dir, "status"), `Name:\t${comm}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
}

test("listOwnedGcrPrompterPids returns only same-user gcr-prompter processes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-proc-"));
  try {
    fakeProcEntry(root, 100, "gcr-prompter", 1000);
    fakeProcEntry(root, 101, "gcr-prompter", 1001);
    fakeProcEntry(root, 102, "chromium", 1000);
    assert.deepEqual(listOwnedGcrPrompterPids({ procRoot: root, uid: 1000 }), [100]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findNewPromptPids excludes baseline and already handled processes", () => {
  assert.deepEqual(findNewPromptPids([10, 11], [10, 11, 12, 13], [12]), [13]);
});

test("watchAndDismissNewGcrPrompters cancels only new prompt once", async () => {
  let clock = 0;
  const sequence = [[10], [10, 20], [10, 20], [10]];
  let scan = 0;
  const killed = [];
  const cancelled = await watchAndDismissNewGcrPrompters({
    baselinePids: [10],
    listPids: () => sequence[Math.min(scan++, sequence.length - 1)],
    killProcess: (pid, signal) => killed.push([pid, signal]),
    pollMs: 100,
    timeoutMs: 300,
    now: () => clock,
    sleep: async (ms) => { clock += ms; }
  });
  assert.deepEqual(killed, [[20, "SIGTERM"]]);
  assert.deepEqual(cancelled, [20]);
});



test("startup policy can dismiss an already-open prompt by using an empty baseline", async () => {
  let clock = 0;
  const killed = [];
  const cancelled = await watchAndDismissNewGcrPrompters({
    baselinePids: [],
    listPids: () => [55],
    killProcess: (pid, signal) => killed.push([pid, signal]),
    pollMs: 100,
    timeoutMs: 100,
    now: () => clock,
    sleep: async (ms) => { clock += ms; }
  });
  assert.deepEqual(killed, [[55, "SIGTERM"]]);
  assert.deepEqual(cancelled, [55]);
});

test("watchAndDismissNewGcrPrompters never cancels a baseline prompt", async () => {
  let clock = 0;
  const killed = [];
  await watchAndDismissNewGcrPrompters({
    baselinePids: [55],
    listPids: () => [55],
    killProcess: (pid) => killed.push(pid),
    pollMs: 100,
    timeoutMs: 200,
    now: () => clock,
    sleep: async (ms) => { clock += ms; }
  });
  assert.deepEqual(killed, []);
});
