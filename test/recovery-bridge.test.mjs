import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridgeServer } from "../src/bridge.mjs";
import { ProjectRuntimeStore } from "../src/runtime-store.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-recovery-bridge-"));
  const project = { id:"demo", name:"Demo", enabled:true, backend:"browser", chatUrl:"https://chatgpt.com/c/demo" };
  const file = path.join(root, "projects.json");
  fs.writeFileSync(file, JSON.stringify({ projects:[project] }), { mode:0o600 });
  const runtimeStore = new ProjectRuntimeStore({ stateDir:root, projects:[project] });
  return { root, project, file, runtimeStore };
}

async function post(base, route, body) {
  const response = await fetch(`${base}${route}`, { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify(body) });
  return { response, json:await response.json() };
}

test("recovery bridge persists stages, dedupes alerts and exposes restart callback", async (t) => {
  const { project, file, runtimeStore } = fixture();
  const sent=[]; const restarts=[];
  const server = await createBridgeServer({
    host:"127.0.0.1", port:0, projects:[project], projectsFile:file, runtimeStore,
    notifier:{ enabled:true, async send(message){ sent.push(message); return true; } },
    logger:{ info(){}, error(){} }, progressWatchdog:{ observe(){ return {ok:true}; } },
    onBrowserRestart:(payload)=>restarts.push(payload)
  });
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  let result=await post(base,"/recovery-report",{projectId:"demo",stage:"soft_reload",reason:"composer_missing",attempts:1,softReloads:1,nextCheckAt:5000});
  assert.equal(result.response.status,200);
  assert.equal(runtimeStore.snapshot("demo").recovery.softReloads,1);
  result=await post(base,"/recovery-failed",{projectId:"demo",reason:"composer_missing"});
  assert.equal(result.json.delivered,true);
  assert.equal(sent.length,1);
  result=await post(base,"/recovery-failed",{projectId:"demo",reason:"composer_missing"});
  assert.equal(result.json.suppressed,true);
  assert.equal(sent.length,1);
  result=await post(base,"/browser-restart-request",{projectId:"demo",reason:"session_unhealthy"});
  assert.equal(result.response.status,202);
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.deepEqual(restarts,[{projectId:"demo",reason:"session_unhealthy"}]);
});
