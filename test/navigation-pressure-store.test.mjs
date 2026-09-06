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

test("rate-limit strikes escalate backoff and decay after a clean window", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-pressure-"));
  const file = path.join(dir, "navigation-pressure.json");
  const store = new NavigationPressureStore({
    file,
    rateLimitBackoffScheduleMs:[100_000,200_000,400_000,800_000],
    rateLimitCleanWindowMs:1_000_000,
    minNavigationGapMs:30_000
  });
  try {
    const first = await store.recordRateLimit(1_000_000);
    assert.equal(first.rateLimitStrikes, 1);
    assert.equal(first.backoffUntil, 1_100_000);
    const second = await store.recordRateLimit(1_200_000);
    assert.equal(second.rateLimitStrikes, 2);
    assert.equal(second.backoffUntil, 1_400_000);
    const third = await store.recordRateLimit(1_500_000);
    assert.equal(third.rateLimitStrikes, 3);
    assert.equal(third.backoffUntil, 1_900_000);
    const afterClean = await store.claimNavigation(2_600_001);
    assert.equal(afterClean.allowed, true);
    assert.equal(afterClean.rateLimitStrikes, 0);
    const reset = await store.recordRateLimit(2_700_000);
    assert.equal(reset.rateLimitStrikes, 1);
    assert.equal(reset.backoffUntil, 2_800_000);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test("duplicate rate-limit observations during one active backoff do not create extra strikes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-pressure-"));
  const store = new NavigationPressureStore({
    file:path.join(dir,"navigation-pressure.json"),
    rateLimitBackoffScheduleMs:[100_000,200_000,400_000],
    rateLimitCleanWindowMs:1_000_000
  });
  try {
    const first = await store.recordRateLimit(1_000_000);
    const duplicate = await store.recordRateLimit(1_050_000);
    assert.equal(first.rateLimitStrikes, 1);
    assert.equal(duplicate.rateLimitStrikes, 1);
    assert.equal(duplicate.backoffUntil, first.backoffUntil);
    const nextIncident = await store.recordRateLimit(1_100_001);
    assert.equal(nextIncident.rateLimitStrikes, 2);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});
