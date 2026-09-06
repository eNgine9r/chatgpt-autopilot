import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridgeServer } from "../src/bridge.mjs";
import { NavigationPressureStore } from "../src/navigation-pressure-store.mjs";

async function post(base, body) {
  const response = await fetch(`${base}/navigation-pressure`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  return { response, json: await response.json() };
}

test("loopback pressure endpoint atomically claims navigation and exposes shared backoff", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-pressure-bridge-"));
  const project = { id:"demo", name:"Demo", enabled:true, backend:"browser", chatUrl:"https://chatgpt.com/c/demo" };
  const projectsFile = path.join(root, "projects.json");
  fs.writeFileSync(projectsFile, JSON.stringify({ projects:[project] }), { mode:0o600 });
  const navigationPressureStore = new NavigationPressureStore({ file:path.join(root,"pressure.json") });
  const server = await createBridgeServer({
    host:"127.0.0.1", port:0, projects:[project], projectsFile, navigationPressureStore,
    notifier:{enabled:false,async send(){return false;}}, logger:{info(){},error(){}},
    progressWatchdog:{observe(){return {ok:true};},snapshot(){return {alerted:false};}}
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const first = await post(base, { action:"claim_navigation" });
  assert.equal(first.response.status, 200);
  assert.equal(first.json.allowed, true);
  const second = await post(base, { action:"claim_navigation" });
  assert.equal(second.json.allowed, false);

  const limited = await post(base, { action:"rate_limit" });
  assert.equal(limited.response.status, 200);
  assert.ok(limited.json.backoffUntil > Date.now());
  assert.equal(limited.json.rateLimitStrikes, 1);
  const duplicate = await post(base, { action:"rate_limit" });
  assert.equal(duplicate.json.rateLimitStrikes, 1);
  assert.equal(duplicate.json.backoffUntil, limited.json.backoffUntil);
  const snapshot = await (await fetch(`${base}/navigation-pressure`)).json();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.rateLimitStrikes, 1);
  assert.equal(snapshot.backoffUntil, limited.json.backoffUntil);
  assert.equal((await post(base, { action:"claim_navigation" })).json.allowed, false);
});
