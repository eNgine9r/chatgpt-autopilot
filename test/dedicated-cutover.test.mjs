import test from "node:test";
import assert from "node:assert/strict";
import { isFreshPausedIdleState, validateDedicatedV2Project, acceptsDedicatedV2Status, renderDedicatedWorkerUnits } from "../src/dedicated-cutover.mjs";
import { withExtensionsDeveloperMode } from "../src/chromium-profile.mjs";

function project(overrides = {}) {
  return { id: "autopilot-development", enabled: true, backend: "browser", chatUrl: "https://chatgpt.com/g/g-p-demo/c/demo", browserRecovery: { enabled: true, allowSessionRestart: false }, checkpointLedger: { enabled: true }, chatDiscovery: { enabled: true, autoAdopt: false }, ...overrides };
}
function state(overrides = {}) {
  return { control: { paused: true }, runtime: { lastSeenAt: 100000, progressKey: "assistant|x|finished|idle|y", status: "operator_paused" }, ...overrides };
}


test("developer mode preference is enabled without dropping existing Chromium settings", () => {
  const original = { browser: { check_default_browser: false }, extensions: { pinned_by_default: true, ui: { other: "keep" } }, profile: { name: "Autopilot" } };
  const next = withExtensionsDeveloperMode(original);
  assert.equal(next.extensions.ui.developer_mode, true);
  assert.equal(next.extensions.ui.other, "keep");
  assert.equal(next.extensions.pinned_by_default, true);
  assert.deepEqual(next.browser, original.browser);
  assert.deepEqual(next.profile, original.profile);
  assert.equal(original.extensions.ui.developer_mode, undefined);
  assert.equal(withExtensionsDeveloperMode(null).extensions.ui.developer_mode, true);
});

test("dedicated cutover mutates only from a fresh paused idle state", () => {
  assert.equal(isFreshPausedIdleState(state(), { now: 100000 }), true);
  assert.equal(isFreshPausedIdleState(state({ control: { paused: false } }), { now: 100000 }), false);
  assert.equal(isFreshPausedIdleState(state({ runtime: { lastSeenAt: 100000, progressKey: "assistant|x|unknown|generating|y", status: "working" } }), { now: 100000 }), false);
  assert.equal(isFreshPausedIdleState(state(), { now: 140001 }), false);
});

test("dedicated v2 project policy preserves staged safety flags", () => {
  assert.equal(validateDedicatedV2Project(project()).id, "autopilot-development");
  assert.throws(() => validateDedicatedV2Project(project({ browserRecovery: { enabled: true, allowSessionRestart: true } })), /unsafe_browser_recovery/);
  assert.throws(() => validateDedicatedV2Project(project({ checkpointLedger: { enabled: false } })), /checkpoint_ledger_required/);
  assert.throws(() => validateDedicatedV2Project(project({ chatDiscovery: { enabled: true, autoAdopt: true } })), /unsafe_chat_discovery/);
});

test("post-cutover acceptance requires a newer fresh paused heartbeat and v2 features", () => {
  const payload = { projects: [{ ...project(), state: state({ runtime: { lastSeenAt: 100001, progressKey: "assistant|x|finished|idle|y", status: "operator_paused" } }) }] };
  assert.equal(acceptsDedicatedV2Status(payload, { beforeSeen: 100000, now: 100001 }), true);
  assert.equal(acceptsDedicatedV2Status(payload, { beforeSeen: 100001, now: 100001 }), false);
  payload.projects[0].browserRecovery.allowSessionRestart = true;
  assert.equal(acceptsDedicatedV2Status(payload, { beforeSeen: 100000, now: 100001 }), false);
});

test("rendered units pin the private project config, canonical extension, and loopback bridge launcher", () => {
  const units = renderDedicatedWorkerUnits({ appDir: "/srv/autopilot", nodeBin: "/opt/node/bin/node", projectsFile: "/srv/autopilot/runtime/projects-autopilot-dev-v2.json", stateDir: "/srv/autopilot/state-autopilot-dev", homeDir: "/home/u", runtimeDir: "/run/user/1000", chatUrl: "https://chatgpt.com/g/g-p-demo/c/demo" });
  assert.match(units.bridge, /PROJECTS_FILE=\/srv\/autopilot\/runtime\/projects-autopilot-dev-v2\.json/);
  assert.match(units.bridge, /browser-worker\.mjs/);
  assert.match(units.browser, /--load-extension=\/srv\/autopilot\/extension/);
  assert.match(units.browser, /DBUS_SESSION_BUS_ADDRESS=unix:path=\/run\/user\/1000\/bus/);
  assert.doesNotMatch(units.browser, /extension-autopilot-dev-v2/);
});
