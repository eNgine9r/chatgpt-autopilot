import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

await import("../extension/navigation-pressure-policy.js");
const Pressure = globalThis.AutopilotNavigationPressurePolicy;
const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const worker = fs.readFileSync(new URL(`../extension/${manifest.background.service_worker}`, import.meta.url), "utf8");

test("operator pause suppresses automatic navigation but explicit forced scan can remain explicit", () => {
  const base = { now: 1_000_000, lastNavigationAt: 0, backoffUntil: 0, minGapMs: 90_000 };
  assert.equal(Pressure.canStartNavigation({ ...base, paused: true, forced: false }), false);
  assert.equal(Pressure.canStartNavigation({ ...base, paused: true, forced: true }), true);
  assert.equal(Pressure.canStartNavigation({ ...base, paused: false, forced: false }), true);
});

test("shared minimum gap prevents adjacent project navigation bursts", () => {
  const base = { paused: false, forced: false, lastNavigationAt: 1_000_000, backoffUntil: 0, minGapMs: 90_000 };
  assert.equal(Pressure.canStartNavigation({ ...base, now: 1_030_000 }), false);
  assert.equal(Pressure.canStartNavigation({ ...base, now: 1_089_999 }), false);
  assert.equal(Pressure.canStartNavigation({ ...base, now: 1_090_000 }), true);
});

test("rate-limit backoff blocks even forced navigation and only extends monotonically", () => {
  const until = Pressure.nextRateLimitBackoff({ now: 2_000_000, currentBackoffUntil: 0, durationMs: 600_000 });
  assert.equal(until, 2_600_000);
  assert.equal(Pressure.canStartNavigation({ paused: false, forced: true, now: 2_100_000, lastNavigationAt: 0, backoffUntil: until }), false);
  assert.equal(Pressure.nextRateLimitBackoff({ now: 2_050_000, currentBackoffUntil: 2_900_000, durationMs: 600_000 }), 2_900_000);
});

test("v19 worker applies pressure policy to mirror, discovery and recovery paths", () => {
  assert.match(worker, /project\.control\?\.paused\) continue;/);
  assert.match(worker, /if \(status\.rateLimited\) \{ await markRateLimitBackoff\(\); return; \}/);
  assert.match(worker, /claimBrowserNavigation\(\{ paused: Boolean\(project\.control\?\.paused\) \}\)/);
  assert.match(worker, /claimBrowserNavigation\(\{ paused: Boolean\(project\.control\?\.paused\), forced \}\)/);
  assert.match(worker, /if \(stage === "idle" \|\| project\.control\?\.paused\) continue;/);
  assert.match(worker, /rate_limited_backoff/);
  assert.match(worker, /NAVIGATION_MIN_GAP_MS = 90000/);
  assert.match(worker, /action: "claim_navigation"/);
  assert.match(worker, /bridge\("\/navigation-pressure"/);
  assert.doesNotMatch(worker, /chrome\.storage\.session\.get\(NAVIGATION_PRESSURE_KEY/);
  assert.match(worker, /const forced = mode === "manual"/);
  assert.match(worker, /navigation_pressure_backoff/);
  assert.match(worker, /claimBrowserNavigation\(\)[\s\S]*stage: "browser_restart"[\s\S]*browser-restart-request/);
  assert.match(worker, /operator_paused/);
  assert.match(worker, /navigation_pressure_backoff/);
});
