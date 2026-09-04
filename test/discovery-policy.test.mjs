import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/discovery-policy.js");
const { shouldStartScan, shouldAdopt } = globalThis.AutopilotDiscoveryPolicy;

test("active generation blocks discovery and adoption", () => {
  assert.equal(shouldStartScan({ enabled:true, pending:false, generating:true, paused:false, forced:true, due:true }), false);
  assert.equal(shouldAdopt({ mode:"auto", generating:true, paused:false, candidate:"x" }), false);
  assert.equal(shouldAdopt({ mode:"manual", generating:true, paused:false, candidate:"x" }), false);
});

test("operator pause blocks automatic but not completed manual adoption", () => {
  assert.equal(shouldAdopt({ mode:"auto", generating:false, paused:true, candidate:"x" }), false);
  assert.equal(shouldAdopt({ mode:"manual", generating:false, paused:true, candidate:"x" }), true);
});

test("forced scan may run while paused after generation finishes", () => {
  assert.equal(shouldStartScan({ enabled:true, pending:false, generating:false, paused:true, forced:true, due:false }), true);
  assert.equal(shouldStartScan({ enabled:true, pending:false, generating:false, paused:true, forced:false, due:true }), false);
});
