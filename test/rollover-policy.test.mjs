import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/rollover-policy.js");
const { composeHandoff, serialProcessor } = globalThis.AutopilotRolloverPolicy;

test("oversized rollover preserves bounded preamble and newest chat tail", () => {
  const preamble=`PLAN-${"p".repeat(20000)}`;
  const handoff=`OLD-${"x".repeat(6000)}-NEWEST`;
  const prompt=composeHandoff({preamble,handoff});
  assert.ok(prompt.length <= 20000);
  assert.match(prompt,/^PLAN-/);
  assert.match(prompt,/BOUNDED CHAT TAIL/);
  assert.match(prompt,/-NEWEST/);
  assert.doesNotMatch(prompt,/OLD-/);
});

test("concurrent rollover triggers serialize completion side effects", async () => {
  let entryPresent = true;
  let completions = 0;
  let active = 0;
  let maxActive = 0;
  const processPending = serialProcessor(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (!entryPresent) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
      completions += 1;
      entryPresent = false;
    } finally {
      active -= 1;
    }
  });

  await Promise.all([processPending(), processPending(), processPending()]);
  assert.equal(maxActive, 1);
  assert.equal(completions, 1);
});

test("serialized rollover processing continues after a rejected attempt", async () => {
  let attempts = 0;
  const processPending = serialProcessor(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("bridge unavailable");
    return "ok";
  });

  await assert.rejects(processPending(), /bridge unavailable/);
  assert.equal(await processPending(), "ok");
  assert.equal(attempts, 2);
});

test("service worker routes all rollover triggers through one serialized processor", async () => {
  const fs = await import("node:fs");
  const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  const worker = fs.readFileSync(new URL(`../extension/${manifest.background.service_worker}`, import.meta.url), "utf8");
  assert.match(worker, /const processPendingRolloversSerial = AutopilotRolloverPolicy\.serialProcessor\(processPendingRollovers\);/);
  assert.match(worker, /await processPendingRolloversSerial\(\);/);
  assert.equal((worker.match(/processPendingRolloversSerial\(\)\.catch/g) || []).length, 2);
  assert.equal((worker.match(/processPendingRolloversSerial\(\)/g) || []).length, 3);
  assert.doesNotMatch(worker, /processPendingRollovers\(\)\.catch/);
});
