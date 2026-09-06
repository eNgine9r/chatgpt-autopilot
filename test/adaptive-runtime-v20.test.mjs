import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync(new URL("../extension/service-worker-v20.js", import.meta.url), "utf8");
const content = fs.readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");

test("v20 healthy-idle mirror uses adaptive audit schedule instead of fixed 120-second due polling", () => {
  assert.match(worker, /initialMirrorAuditAt\(/);
  assert.match(worker, /mirrorBaseMs\(project\)/);
  assert.match(worker, /MIRROR_BASE_MS/);
  assert.doesNotMatch(worker, /const intervalMs = Number\(project\.browserRecovery\?\.mirrorSyncSeconds \|\| 120\) \* 1000;\s*const due = now - Number\(last\.lastProbeAt \|\| 0\) >= intervalMs;/);
});

test("v20 discovery scans the configured owner tab before considering Project-root navigation", () => {
  const fnStart = worker.indexOf("async function maybeStartDiscoveryScans()");
  const fnEnd = worker.indexOf("async function processPendingDiscoveries()", fnStart);
  const body = worker.slice(fnStart, fnEnd);
  const inPlace = body.indexOf('chrome.tabs.sendMessage(sourceTab.id, { type: "DISCOVERY_SCAN"');
  const createRoot = body.indexOf('chrome.tabs.create({ url: project.projectRootUrl');
  assert.ok(inPlace >= 0);
  assert.ok(createRoot > inPlace);
  assert.match(body, /inPlaceConclusive && !forced/);
  assert.match(body, /shouldUseFullDiscovery/);
});

test("v20 pulse is serialized and high-priority recovery or rollover blocks low-priority scans", () => {
  assert.match(worker, /let pulseTail = Promise\.resolve\(\)/);
  assert.match(worker, /function enqueuePulse\(\)/);
  const start = worker.indexOf("async function runPulse()");
  const end = worker.indexOf("let pulseTail", start);
  const body = worker.slice(start, end);
  const recovery = body.indexOf("await processRecoveries()");
  const rollover = body.indexOf("await processPendingRolloversSerial()");
  const firstGate = body.indexOf("if (await hasHighPriorityWork()) return;");
  const discovery = body.indexOf("await maybeStartDiscoveryScans()");
  const mirror = body.indexOf("await maybeStartMirrorProbe()");
  assert.ok(recovery >= 0 && rollover > recovery);
  assert.ok(firstGate > rollover);
  assert.ok(discovery > firstGate);
  assert.ok(mirror > discovery);
});

test("rate-limit DOM detection is event-driven and accepted from any ChatGPT surface", () => {
  assert.match(content, /RATE_LIMIT_DETECTED/);
  assert.match(content, /if \(await reportRateLimitIfPresent\(blockers\)\) return;/);
  assert.match(worker, /case "RATE_LIMIT_DETECTED"/);
  assert.match(worker, /source\.origin !== "https:\/\/chatgpt\.com"/);
  assert.match(worker, /if \(!projectId\) \{[\s\S]*markRateLimitBackoff\(\)/);
});

test("mirror same results update adaptive schedule and refresh resets it", () => {
  assert.match(worker, /updateMirrorSchedule\(project, lastKey, last, disposition\.action/);
  assert.match(worker, /updateMirrorSchedule\(project, lastKey, last, "refresh"/);
});


test("pulse preflights every already-open ChatGPT tab for rate limiting before recovery decisions", () => {
  const start = worker.indexOf("async function runPulse()");
  const end = worker.indexOf("let pulseTail", start);
  const body = worker.slice(start, end);
  const preflight = body.indexOf("await detectOpenTabRateLimit(tabs)");
  const monitor = body.indexOf("await monitorConfiguredTabs()");
  assert.ok(preflight >= 0 && monitor > preflight);
  assert.match(worker, /async function detectOpenTabRateLimit\(tabs = \[\]\)/);
  assert.match(worker, /GET_RUNTIME_STATUS/);
  assert.match(worker, /if \(!status\?\.rateLimited\) continue;/);
  assert.match(worker, /await markRateLimitBackoff\(\)/);
});
