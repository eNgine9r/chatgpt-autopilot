import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/generation-policy.js");
const Generation = globalThis.AutopilotGenerationPolicy;

function fakeNode({ hidden = false, disabled = false, ariaHidden = "", ariaDisabled = "", width = 24, height = 24 } = {}) {
  return {
    isConnected: true,
    hidden,
    disabled,
    getAttribute(name) {
      if (name === "aria-hidden") return ariaHidden;
      if (name === "aria-disabled") return ariaDisabled;
      return "";
    },
    getBoundingClientRect() { return { width, height }; }
  };
}

function fakeDocument(selector, nodes) {
  return { querySelectorAll(value) { return value === selector ? nodes : []; } };
}

const visibleWindow = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };

test("generation selectors are specific and exclude broad Stop matches", () => {
  assert.equal(Generation.STOP_SELECTORS.includes('button[aria-label*="Stop"]'), false);
  assert.equal(Generation.STOP_SELECTORS.includes('button[title*="Stop"]'), false);
  assert.ok(Generation.STOP_SELECTORS.includes('button[data-testid="stop-button"]'));
});

test("only a visible interactive generation stop control counts as generating", () => {
  const selector = 'button[data-testid="stop-button"]';
  assert.equal(Generation.isGenerating(fakeDocument(selector, [fakeNode()]), visibleWindow), true);
  assert.equal(Generation.isGenerating(fakeDocument(selector, [fakeNode({ hidden: true })]), visibleWindow), false);
  assert.equal(Generation.isGenerating(fakeDocument(selector, [fakeNode({ disabled: true })]), visibleWindow), false);
  assert.equal(Generation.isGenerating(fakeDocument(selector, [fakeNode({ ariaHidden: "true" })]), visibleWindow), false);
  assert.equal(Generation.isGenerating(fakeDocument(selector, [fakeNode({ ariaDisabled: "true" })]), visibleWindow), false);
  assert.equal(Generation.isGenerating(fakeDocument(selector, [fakeNode({ width: 0 })]), visibleWindow), false);
});

test("hidden styles and unrelated Stop buttons fail closed as non-generation controls", () => {
  const selector = '#composer-stop-button';
  const hiddenWindow = { getComputedStyle: () => ({ display: "none", visibility: "visible" }) };
  assert.equal(Generation.isGenerating(fakeDocument(selector, [fakeNode()]), hiddenWindow), false);
  const unrelatedDocument = {
    querySelectorAll(value) {
      return value === 'button[aria-label*="Stop"]' ? [fakeNode()] : [];
    }
  };
  assert.equal(Generation.isGenerating(unrelatedDocument, visibleWindow), false);
});


test("manifest rotates the background worker for cache-safe deployment", async () => {
  const fs = await import("node:fs");
  const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.version, "0.3.15");
  assert.equal(manifest.background.service_worker, "service-worker-v13.js");
  const worker = fs.readFileSync(new URL(`../extension/${manifest.background.service_worker}`, import.meta.url), "utf8");
  const version = manifest.background.service_worker.match(/service-worker-(v\d+)\.js$/)?.[1] || "";
  assert.ok(version);
  assert.match(worker, new RegExp(`backgroundWorker:\\s*["']${version}["']`));
});
