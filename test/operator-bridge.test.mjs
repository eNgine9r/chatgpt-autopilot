import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridgeServer } from "../src/bridge.mjs";
import { ProjectRuntimeStore } from "../src/runtime-store.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-operator-bridge-"));
  const project = { id: "demo", name: "Demo", enabled: true, backend: "browser", chatUrl: "https://chatgpt.com/c/demo", chatDiscovery: { enabled: true } };
  const file = path.join(root, "projects.json");
  fs.writeFileSync(file, JSON.stringify({ projects: [project] }));
  const store = new ProjectRuntimeStore({ stateDir: root, projects: [project] });
  return { root, project, file, store };
}

async function post(base, route, body) {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { response, body: await response.json() };
}
test("bridge exposes loopback operator status and durable actions", async (t) => {
  const { project, file, store } = fixture();
  const server = await createBridgeServer({
    host: "127.0.0.1", port: 0, projects: [project], projectsFile: file,
    notifier: { enabled: false, async send() { return false; } },
    logger: { info() {}, error() {} },
    progressWatchdog: { observe() { return { ok: true }; }, snapshot() { return { alerted: false }; } },
    runtimeStore: store
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const status = await fetch(`${base}/operator/status`);
  const statusBody = await status.json();
  assert.equal(status.status, 200);
  assert.equal(statusBody.projects[0].id, "demo");

  const pause = await post(base, "/operator/action", { projectId: "demo", action: "pause" });
  assert.equal(pause.response.status, 200);
  assert.equal(store.control("demo").paused, true);
  const restart = await post(base, "/operator/action", { projectId: "demo", action: "restart" });
  assert.equal(restart.response.status, 200);
  assert.equal(store.control("demo").restartGeneration, 1);
});
