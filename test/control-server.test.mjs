import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createControlServer } from "../src/control-server.mjs";
import { ProjectRuntimeStore } from "../src/runtime-store.mjs";

function signed(token, userId) {
  const authDate = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify({ id: userId }) });
  const check = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

test("control API authenticates owner and persists project actions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-control-"));
  const miniappDir = path.join(root, "web"); fs.mkdirSync(miniappDir); fs.writeFileSync(path.join(miniappDir,"index.html"),"ok"); fs.writeFileSync(path.join(miniappDir,"app.js"),""); fs.writeFileSync(path.join(miniappDir,"styles.css"),"");
  const projects = [{ id: "demo", name: "Demo", chatUrl: "https://chatgpt.com/c/x", planVersion: "v1", chatDiscovery: { enabled: true, autoAdopt: false } }];
  const runtimeStore = new ProjectRuntimeStore({ stateDir: root, projects });
  const server = await createControlServer({ host:"127.0.0.1", port:0, projects, runtimeStore, progressWatchdog:{snapshot:()=>({alerted:false})}, logger:{info(){},error(){}}, telegramBotToken:"123:test", telegramOwnerUserId:"42", miniappDir });
  t.after(() => new Promise((resolve)=>server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const unauth = await fetch(`${base}/api/status`); assert.equal(unauth.status, 401);
  const headers = { authorization:`tma ${signed("123:test",42)}`, "content-type":"application/json" };
  const status = await fetch(`${base}/api/status`,{headers}); assert.equal(status.status,200);
  const pause = await fetch(`${base}/api/projects/demo/action`,{method:"POST",headers,body:JSON.stringify({action:"pause"})}); assert.equal(pause.status,200); assert.equal(runtimeStore.control("demo").paused,true);
  await fetch(`${base}/api/projects/demo/action`,{method:"POST",headers,body:JSON.stringify({action:"restart"})}); assert.equal(runtimeStore.control("demo").restartGeneration,1);
  await fetch(`${base}/api/projects/demo/action`,{method:"POST",headers,body:JSON.stringify({action:"scan_chats"})}); assert.equal(runtimeStore.control("demo").discoveryScanGeneration,1);
  runtimeStore.recordDiscovery("demo", { url:"https://chatgpt.com/g/g-p-demo/c/new", title:"New" });
  const adopt = await fetch(`${base}/api/projects/demo/action`,{method:"POST",headers,body:JSON.stringify({action:"adopt_candidate"})}); assert.equal(adopt.status,200); assert.equal(runtimeStore.control("demo").adoptGeneration,1);
});
