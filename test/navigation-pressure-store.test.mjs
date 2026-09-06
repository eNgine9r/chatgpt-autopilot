import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NavigationPressureStore } from "../src/navigation-pressure-store.mjs";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-pressure-"));
  const file = path.join(dir, "navigation-pressure.json");
  return { dir, file, a: new NavigationPressureStore({ file, rateLimitBackoffMs: 600000 }), b: new NavigationPressureStore({ file, rateLimitBackoffMs: 600000 }) };
}

test("separate bridge processes share one durable navigation pressure state", async () => {
  const { dir, a, b } = tempStore();
  try {
    const claimed = await a.claimNavigation(1_000_000);
    assert.equal(claimed.allowed, true);
    assert.equal(b.snapshot().lastNavigationAt, 1_000_000);
    await b.recordRateLimit(1_100_000);
    const state = a.snapshot();
    assert.equal(state.lastNavigationAt, 1_000_000);
    assert.equal(state.lastRateLimitAt, 1_100_000);
    assert.equal(state.backoffUntil, 1_700_000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent cross-profile claims allow exactly one navigation inside the shared gap", async () => {
  const { dir, a, b } = tempStore();
  try {
    const results = await Promise.all([a.claimNavigation(2_000_000), b.claimNavigation(2_000_000)]);
    assert.equal(results.filter((item) => item.allowed).length, 1);
    assert.equal(a.snapshot().lastNavigationAt, 2_000_000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent navigation claim and rate-limit update preserve monotonic safety state", async () => {
  const { dir, a, b } = tempStore();
  try {
    await Promise.all([a.claimNavigation(3_000_000), b.recordRateLimit(3_000_001)]);
    const state = a.snapshot();
    assert.ok(state.lastNavigationAt === 0 || state.lastNavigationAt === 3_000_000);
    assert.equal(state.lastRateLimitAt, 3_000_001);
    assert.equal(state.backoffUntil, 3_600_001);
    assert.equal((await a.claimNavigation(3_100_000)).allowed, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
