import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/recovery-policy.js");
const { mayMutateTab, nextStage, shouldRestartBrowser } = globalThis.AutopilotRecoveryPolicy;

test("unknown or active generation never permits browser mutation", () => {
  assert.equal(mayMutateTab({ generatingKnown:false, generating:false }), false);
  assert.equal(mayMutateTab({ generatingKnown:true, generating:true }), false);
  assert.equal(mayMutateTab({ generatingKnown:true, generating:false }), true);
});

test("auth rate-limit and safety gates block browser mutation", () => {
  assert.equal(mayMutateTab({ generatingKnown:true, generating:false, authBlocked:true }), false);
  assert.equal(mayMutateTab({ generatingKnown:true, generating:false, rateLimited:true }), false);
  assert.equal(mayMutateTab({ generatingKnown:true, generating:false, safetyBlocked:true }), false);
});

test("recovery ladder is soft reload then recreate then escalation", () => {
  assert.equal(nextStage({ stage:"idle", tabPresent:true, canMutate:true }), "soft_reload");
  assert.equal(nextStage({ stage:"idle", tabPresent:false, canMutate:true }), "tab_recreate");
  assert.equal(nextStage({ stage:"soft_reload", tabPresent:true, canMutate:true }), "tab_recreate");
  assert.equal(nextStage({ stage:"tab_recreate", tabPresent:true, canMutate:true }), "escalate");
});

test("session restart requires all enabled browser projects unhealthy and none generating", () => {
  assert.equal(shouldRestartBrowser({ unhealthyCount:2, enabledCount:2, activeGenerationCount:0 }), true);
  assert.equal(shouldRestartBrowser({ unhealthyCount:1, enabledCount:2, activeGenerationCount:0 }), false);
  assert.equal(shouldRestartBrowser({ unhealthyCount:2, enabledCount:2, activeGenerationCount:1 }), false);
  assert.equal(shouldRestartBrowser({ unhealthyCount:2, enabledCount:2, activeGenerationCount:0, unknownGenerationCount:1 }), false);
});
