import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/bridge-policy.js");
const { projectIdFromUrl, scoreCandidate, selectBridge } = globalThis.AutopilotBridgePolicy;

const btcRoot = "https://chatgpt.com/g/g-p-11111111111111111111111111111111/project";
const btcChat = "https://chatgpt.com/g/g-p-11111111111111111111111111111111-btc/c/aaa";
const nexoRoot = "https://chatgpt.com/g/g-p-22222222222222222222222222222222/project";
const nexoChat = "https://chatgpt.com/g/g-p-22222222222222222222222222222222-nexo/c/bbb";
const devRoot = "https://chatgpt.com/g/g-p-33333333333333333333333333333333/project";
const devChat = "https://chatgpt.com/g/g-p-33333333333333333333333333333333-auto/c/ccc";

const shared = { base: "http://127.0.0.1:8765", config: { projects: [
  { id: "btc", chatUrl: btcChat, projectRootUrl: btcRoot },
  { id: "nexo", chatUrl: nexoChat, projectRootUrl: nexoRoot }
] } };
const dedicated = { base: "http://127.0.0.1:8767", config: { projects: [
  { id: "autopilot", chatUrl: devChat, projectRootUrl: devRoot }
] } };

test("bridge policy canonicalizes slugged ChatGPT project URLs", () => {
  assert.equal(projectIdFromUrl(btcChat), "g-p-11111111111111111111111111111111");
  assert.equal(projectIdFromUrl(btcRoot), "g-p-11111111111111111111111111111111");
});

test("dedicated browser profile selects 8767 by its open project tab", () => {
  assert.equal(selectBridge([shared, dedicated], [devChat])?.base, "http://127.0.0.1:8767");
});

test("shared browser profile selects 8765 and rewards multiple matching tabs", () => {
  assert.ok(scoreCandidate(shared, [btcChat, nexoChat]) > scoreCandidate(dedicated, [btcChat, nexoChat]));
  assert.equal(selectBridge([shared, dedicated], [btcChat, nexoChat])?.base, "http://127.0.0.1:8765");
});

test("same-project rollover still resolves when the exact conversation changed", () => {
  const newer = "https://chatgpt.com/g/g-p-33333333333333333333333333333333-new/c/ddd";
  assert.equal(selectBridge([shared, dedicated], [newer])?.base, "http://127.0.0.1:8767");
});

test("ambiguous or unrelated tabs fail closed instead of guessing a bridge", () => {
  assert.equal(selectBridge([shared, dedicated], ["https://chatgpt.com/" ]), null);
  const tieA = { base: "http://127.0.0.1:8765", config: { projects: [{ chatUrl: devChat, projectRootUrl: devRoot }] } };
  assert.equal(selectBridge([tieA, dedicated], [devChat]), null);
});
