import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../extension/source-tab-policy.js", import.meta.url), "utf8");
const context = { globalThis: {} };
vm.runInNewContext(source, context);
const Policy = context.globalThis.AutopilotSourceTabPolicy;
const normalize = (value) => String(value || "").replace(/\/$/, "");

test("responsive selector skips stale exact match and uses the next healthy tab", async () => {
  const probes = [];
  const result = await Policy.firstResponsive({
    tabs: [{ id: 11, url: "https://chatgpt.com/x" }, { id: 12, url: "https://chatgpt.com/x/" }],
    target: "https://chatgpt.com/x", normalize,
    probe: async (id) => { probes.push(id); return id === 12 ? { ok: true, generating: false } : null; }
  });
  assert.equal(result.tab.id, 12);
  assert.equal(result.status.ok, true);
  assert.deepEqual(probes, [11, 12]);
});

test("responsive selector fails closed when all exact matches are unavailable", async () => {
  const result = await Policy.firstResponsive({
    tabs: [{ id: 21, url: "https://chatgpt.com/x" }, { id: 22, url: "https://chatgpt.com/y" }],
    target: "https://chatgpt.com/x", normalize, probe: async () => null
  });
  assert.equal(result, null);
});


test("current discovery worker probes all exact source tabs before failing closed", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  const worker = fs.readFileSync(new URL(`../extension/${manifest.background.service_worker}`, import.meta.url), "utf8");
  assert.match(worker, /const exactSourceTabs = sourceTabs\.filter/);
  assert.match(worker, /AutopilotSourceTabPolicy\.firstResponsive/);
  assert.match(worker, /gate: "source_status_unavailable"/);
});
