import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const worker = fs.readFileSync(new URL(`../extension/${manifest.background.service_worker}`, import.meta.url), "utf8");
const content = fs.readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");

test("mirror probe is marked before same-chat navigation and cannot claim the lease", () => {
  const createAt = worker.indexOf('chrome.tabs.create({ url: "about:blank", active: false })');
  const storeAt = worker.indexOf("[key]: entry");
  const navigateAt = worker.indexOf("chrome.tabs.update(tab.id, { url: project.chatUrl })");
  const probeGuardAt = worker.indexOf("AutopilotMirrorSyncPolicy.isProbeTab");
  const leaseAt = worker.indexOf('const key = `lease:${projectId}`');
  assert.ok(createAt >= 0 && storeAt > createAt && navigateAt > storeAt);
  assert.ok(probeGuardAt >= 0 && leaseAt > probeGuardAt);
});

test("mirror snapshot exposes bounded ordered turn history and safety state", () => {
  assert.match(content, /payload\?\.type === "MIRROR_SNAPSHOT"/);
  assert.match(content, /recentTurnIds: recentTurnIds\(\)/);
  assert.match(content, /generatingKnown: known/);
  assert.match(content, /\.\.\.recoveryBlockers\(\)/);
});

test("mirror lifecycle is driven by the pulse alarm and cleaned with tab removal", () => {
  assert.match(worker, /processPendingMirrorProbes\(\)\.catch/);
  assert.match(worker, /maybeStartMirrorProbe\(\)\.catch/);
  assert.match(worker, /cleanupMirrorEntriesForTab\(tabId\)\.catch/);
  assert.match(worker, /MIRROR_TIMEOUT_MS = 300000/);
  assert.match(worker, /MIRROR_SETTLE_MS = 30000/);
});

test("mirror refresh revalidates the owning tab immediately before mutation", () => {
  assert.match(worker, /chrome\.tabs\.sendMessage\(sourceTab\.id, \{ type: "MIRROR_SNAPSHOT" \}\)/);
  assert.match(worker, /source_changed_or_unsafe_before_refresh/);
  const guard = worker.indexOf("sourceStillSafe");
  const reload = worker.indexOf("chrome.tabs.reload(sourceTab.id)");
  assert.ok(guard >= 0 && reload > guard);
});

test("mirror worker reports observable lifecycle telemetry", () => {
  assert.match(worker, /bridge\("\/mirror-report"/);
  for (const result of ["started", "refresh", "timeout", "error"]) {
    assert.match(worker, new RegExp(`result: ["']${result}["']`));
  }
  assert.match(worker, /result: disposition\.action/);
  assert.match(worker, /\["same", "blocked"\]\.includes\(disposition\.action\)/);
});
