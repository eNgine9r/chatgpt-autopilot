import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync(new URL("../extension/service-worker-v15.js", import.meta.url), "utf8");
const content = fs.readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");

test("mirror probe is marked before same-chat navigation and cannot claim the lease", () => {
  const createAt = worker.indexOf('chrome.tabs.create({ url: "about:blank", active: false })');
  const storeAt = worker.indexOf("[key]: { tabId: tab.id, sourceTabId: sourceTab.id");
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