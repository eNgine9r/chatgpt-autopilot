import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridgeServer } from "../src/bridge.mjs";
import { loadProjects } from "../src/config.mjs";
import { ProjectRuntimeStore } from "../src/runtime-store.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-discovery-bridge-"));
  const file = path.join(root, "projects.json");
  const id = "g-p-0123456789abcdef0123456789abcdef";
  fs.writeFileSync(file, JSON.stringify({ projects: [{
    id: "demo", name: "Demo", enabled: true,
    chatUrl: `https://chatgpt.com/g/${id}/c/current`, projectRootUrl: `https://chatgpt.com/g/${id}/project`,
    continueAfterSeconds: 60, continuationPrompt: "Continue", planVersion: "plan-v7", planAnchor: "Never drift",
    chatDiscovery: { enabled: true, autoAdopt: true, includeTitlePatterns: ["BTC Radar"] }
  }] }, null, 2), { mode: 0o600 });
  const projects = loadProjects(file);
  const runtimeStore = new ProjectRuntimeStore({ stateDir: root, projects });
  return { root, file, id, projects, runtimeStore };
}

async function post(base, route, body) {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { response, json: await response.json() };
}

test("bridge records candidate and adopts only confirmed same-project chat", async (t) => {
  const { file, id, projects, runtimeStore } = fixture();
  const sent = [];
  const server = await createBridgeServer({
    host: "127.0.0.1", port: 0, projects, projectsFile: file, runtimeStore,
    notifier: { enabled: true, async send(message) { sent.push(message); return true; } },
    logger: { info() {}, error() {} }, progressWatchdog: { observe() { return { ok: true }; } }
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  runtimeStore.observe("demo", { progressKey: "before-adopt", status: "assistant", latestAssistantExcerpt: "durable checkpoint survives" });
  const scan = await post(base, "/discovery-candidates", { projectId: "demo", candidates: [
    { url: `https://chatgpt.com/g/${id}/c/current`, title: "BTC Radar current" },
    { url: `https://chatgpt.com/g/${id}-slug/c/new`, title: "BTC Radar next" }
  ] });
  assert.equal(scan.response.status, 200);
  assert.equal(scan.json.shouldAdopt, true);
  assert.equal(runtimeStore.snapshot("demo").discovery.candidateUrl, `https://chatgpt.com/g/${id}-slug/c/new`);
  const rejected = await post(base, "/adopt-chat", { projectId: "demo", mode: "auto", chatUrl: `https://chatgpt.com/g/${id}/c/unseen`, title: "BTC Radar" });
  assert.equal(rejected.response.status, 409);
  const adopted = await post(base, "/adopt-chat", { projectId: "demo", mode: "auto", chatUrl: scan.json.candidate.url, title: scan.json.candidate.title });
  assert.equal(adopted.response.status, 200);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8")).projects[0];
  assert.equal(persisted.chatUrl, scan.json.candidate.url);
  assert.equal(persisted.planAnchor, "Never drift");
  assert.equal(runtimeStore.snapshot("demo").runtime.latestAssistantExcerpt, "durable checkpoint survives");
  assert.equal(runtimeStore.snapshot("demo").discovery.lastAdoptionMode, "auto");
  assert.match(sent.at(-1), /переприв’язався/);
});
