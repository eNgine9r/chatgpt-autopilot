import test from "node:test";
import assert from "node:assert/strict";
import { validateSharedTargets, validateSharedV2Projects, isFreshPausedIdleState, allFreshPausedIdle, acceptsSharedV2Status } from "../src/shared-promotion.mjs";

function project(id, overrides = {}) {
  return {
    id,
    enabled: true,
    backend: "browser",
    browserRecovery: { enabled: true, allowSessionRestart: false },
    chatDiscovery: { enabled: true, autoAdopt: false },
    checkpointLedger: { enabled: true, evidence: { github: { repository: `eNgine9r/${id}`, requireMergedPr: true } } },
    ...overrides
  };
}
function state(lastSeenAt = 100000, overrides = {}) {
  return {
    control: { paused: true },
    runtime: { lastSeenAt, progressKey: "assistant|x|finished|idle|y", status: "operator_paused" },
    ...overrides
  };
}

test("shared targets must be enabled browser projects", () => {
  const projects = [project("btc"), project("nexo")];
  assert.deepEqual(validateSharedTargets(projects, ["btc", "nexo"]).map((item) => item.id), ["btc", "nexo"]);
  assert.throws(() => validateSharedTargets(projects, []), /shared_target_projects_required/);
  assert.throws(() => validateSharedTargets(projects, ["missing"]), /enabled_browser_project_required/);
});
test("shared v2 validation requires staged safety and merged-PR evidence", () => {
  const projects = [project("btc"), project("nexo")];
  assert.equal(validateSharedV2Projects(projects, ["btc", "nexo"]).length, 2);
  assert.throws(() => validateSharedV2Projects([
    project("btc", { browserRecovery: { enabled: true, allowSessionRestart: true } })
  ], ["btc"]), /unsafe_browser_recovery_policy/);
  assert.throws(() => validateSharedV2Projects([
    project("btc", { chatDiscovery: { enabled: true, autoAdopt: true } })
  ], ["btc"]), /unsafe_chat_discovery_policy/);
  assert.throws(() => validateSharedV2Projects([
    project("btc", { checkpointLedger: { enabled: true, evidence: { github: {} } } })
  ], ["btc"]), /merged_pr_evidence_required/);
});

test("promotion barrier requires every target to be fresh paused idle", () => {
  const states = { btc: state(100000), nexo: state(100000) };
  assert.equal(allFreshPausedIdle(states, ["btc", "nexo"], { now: 100001 }), true);
  states.nexo = state(100000, { runtime: { lastSeenAt: 100000, progressKey: "assistant|x|unknown|generating|y", status: "working" } });
  assert.equal(allFreshPausedIdle(states, ["btc", "nexo"], { now: 100001 }), false);
  assert.equal(isFreshPausedIdleState(state(100000), { now: 140001 }), false);
});
test("shared acceptance requires newer heartbeat and v2 feature proof for every target", () => {
  const payload = {
    projects: ["btc", "nexo"].map((id, index) => ({
      ...project(id),
      checkpointLedger: { enabled: true, evidenceConfigured: true },
      state: state(100001 + index)
    }))
  };
  assert.equal(acceptsSharedV2Status(payload, {
    targetIds: ["btc", "nexo"],
    beforeSeen: new Map([["btc", 100000], ["nexo", 100000]]),
    now: 100002
  }), true);
  assert.equal(acceptsSharedV2Status(payload, {
    targetIds: ["btc", "nexo"],
    beforeSeen: new Map([["btc", 100001], ["nexo", 100002]]),
    now: 100002
  }), false);
  payload.projects[1].checkpointLedger.evidenceConfigured = false;
  assert.equal(acceptsSharedV2Status(payload, {
    targetIds: ["btc", "nexo"],
    beforeSeen: { btc: 100000, nexo: 100000 },
    now: 100002
  }), false);
});
