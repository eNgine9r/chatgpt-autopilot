import test from "node:test";
import assert from "node:assert/strict";
import { applyBrowserV2PolicyDocument, browserV2PolicySummary, parseProjectRepositories } from "../src/browser-v2-policy.mjs";

function document() {
  return {
    version: 7,
    projects: [
      {
        id: "btc-radar-development",
        name: "BTC Radar",
        enabled: true,
        chatUrl: "https://chatgpt.com/g/g-p-demo/c/btc",
        planVersion: "2026-09-04-v1",
        planAnchor: "btc-plan"
      },
      {
        id: "nexolab-development",
        name: "NexoLab",
        enabled: true,
        chatUrl: "https://chatgpt.com/g/g-p-demo/c/nexo",
        planVersion: "2026-09-04-v1",
        planAnchor: "nexo-plan"
      }
    ]
  };
}

test("repository assignments are strict and unique", () => {
  const map = parseProjectRepositories(["btc-radar-development=eNgine9r/btc-radar-telegram"]);
  assert.equal(map.get("btc-radar-development"), "eNgine9r/btc-radar-telegram");
  assert.throws(() => parseProjectRepositories([]), /project_repository_required/);
  assert.throws(() => parseProjectRepositories(["bad"]), /invalid_project_repository/);
  assert.throws(() => parseProjectRepositories(["x=a/b", "x=c/d"]), /duplicate_project_repository/);
});

test("v2 policy preserves project identity while adding staged safety and evidence", () => {
  const assignments = new Map([
    ["btc-radar-development", "eNgine9r/btc-radar-telegram"],
    ["nexolab-development", "eNgine9r/nexolab-platform"]
  ]);
  const next = applyBrowserV2PolicyDocument(document(), assignments);
  assert.equal(next.version, 7);
  for (const project of next.projects) {
    assert.equal(project.planVersion, "2026-09-04-v1");
    assert.match(project.chatUrl, /^https:\/\/chatgpt\.com\//);
    assert.equal(project.chatDiscovery.enabled, true);
    assert.equal(project.chatDiscovery.autoAdopt, false);
    assert.equal(project.browserRecovery.enabled, true);
    assert.equal(project.browserRecovery.allowSessionRestart, false);
    assert.equal(project.checkpointLedger.enabled, true);
    assert.equal(project.checkpointLedger.evidence.github.requireMergedPr, true);
    assert.equal(project.checkpointLedger.evidence.github.matchLocalHead, false);
  }
  assert.equal(next.projects[0].checkpointLedger.evidence.github.repository, "eNgine9r/btc-radar-telegram");
  assert.equal(next.projects[1].checkpointLedger.evidence.github.repository, "eNgine9r/nexolab-platform");
});
test("policy summary exposes only rollout-relevant fields", () => {
  const assignments = new Map([["btc-radar-development", "eNgine9r/btc-radar-telegram"]]);
  const next = applyBrowserV2PolicyDocument(document(), assignments);
  assert.deepEqual(browserV2PolicySummary(next, ["btc-radar-development"]), [{
    id: "btc-radar-development",
    chatDiscovery: { enabled: true, autoAdopt: false },
    browserRecovery: { enabled: true, allowSessionRestart: false },
    checkpointLedger: {
      enabled: true,
      repository: "eNgine9r/btc-radar-telegram",
      requireMergedPr: true,
      matchLocalHead: false
    }
  }]);
});

test("policy refuses missing or disabled targets", () => {
  assert.throws(() => applyBrowserV2PolicyDocument(document(), new Map([["missing", "eNgine9r/x"]])), /project_not_found/);
  const disabled = document();
  disabled.projects[0].enabled = false;
  assert.throws(() => applyBrowserV2PolicyDocument(disabled, new Map([["btc-radar-development", "eNgine9r/x"]])), /browser_project_required/);
});
