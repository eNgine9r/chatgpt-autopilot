import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridgeServer } from "../src/bridge.mjs";
import { ProjectRuntimeStore } from "../src/runtime-store.mjs";

async function post(base, route, body) {
  const response = await fetch(`${base}${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  return { response, json: await response.json() };
}

test("mirror report is bounded, durable and visible in operator status", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-mirror-bridge-"));
  const project = { id:"demo", name:"Demo", enabled:true, backend:"browser", chatUrl:"https://chatgpt.com/c/demo", browserRecovery:{enabled:true} };
  const file = path.join(root, "projects.json");
  fs.writeFileSync(file, JSON.stringify({projects:[project]}), {mode:0o600});
  const store = new ProjectRuntimeStore({ stateDir:root, projects:[project] });
  const server = await createBridgeServer({ host:"127.0.0.1", port:0, projects:[project], projectsFile:file, runtimeStore:store,
    notifier:{enabled:false,async send(){return false;}}, logger:{info(){},error(){}},
    progressWatchdog:{observe(){return {ok:true};},snapshot(){return {alerted:false};}} });
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  let result=await post(base,"/mirror-report",{projectId:"demo",result:"refresh",lastProbeAt:1000,sourceTurnId:"s".repeat(400),remoteTurnId:"turn-2",lastObservedAt:2000,lastRefreshAt:2000});
  assert.equal(result.response.status,200);
  assert.equal(result.json.mirrorSync.lastResult,"refresh");
  assert.equal(result.json.mirrorSync.sourceTurnId.length,256);
  const status=await (await fetch(`${base}/operator/status`)).json();
  assert.equal(status.projects[0].state.mirrorSync.remoteTurnId,"turn-2");
  result=await post(base,"/mirror-report",{projectId:"demo",result:"invalid"});
  assert.equal(result.response.status,400);
});
