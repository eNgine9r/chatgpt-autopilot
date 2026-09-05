import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/discovery-policy.js");
const { shouldStartScan, shouldAdopt, scanDisposition, durableCandidate } = globalThis.AutopilotDiscoveryPolicy;

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


test("lazy sidebar discovery waits for an alternative same-project chat", () => {
  assert.equal(scanDisposition({ timedOut:false, currentChatUrl:"current", candidateUrls:[] }), "wait");
  assert.equal(scanDisposition({ timedOut:false, currentChatUrl:"current", candidateUrls:["current"] }), "wait");
  assert.equal(scanDisposition({ timedOut:false, currentChatUrl:"current", candidateUrls:["current","new"] }), "finalize");
});

test("discovery timeout closes a scan even when the sidebar never exposes another chat", () => {
  assert.equal(scanDisposition({ timedOut:true, currentChatUrl:"current", candidateUrls:[] }), "timeout");
  assert.equal(scanDisposition({ timedOut:true, currentChatUrl:"current", candidateUrls:["current","new"] }), "timeout");
});


test("durable discovery state maps to the manual adoption candidate shape", () => {
  assert.deepEqual(durableCandidate({
    candidateUrl:"https://chatgpt.com/g/project/c/new",
    candidateTitle:"Newest chat", candidatePreview:"preview"
  }), { url:"https://chatgpt.com/g/project/c/new", title:"Newest chat", preview:"preview" });
  assert.deepEqual(durableCandidate({}), { url:"", title:"", preview:"" });
});
