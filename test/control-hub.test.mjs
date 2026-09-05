import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createControlServer } from "../src/control-server.mjs";

function signed(token, userId) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId }) });
  const check = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

function miniapp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-hub-"));
  for (const name of ["index.html", "app.js", "styles.css"]) fs.writeFileSync(path.join(root, name), name);
  return root;
}
test("Telegram control hub authenticates owner and routes worker actions", async (t) => {
  const calls = []; let restartBlocked = false;
  const registry = {
    async status() { return { ok: true, generatedAt: Date.now(), workers: [{ id: "shared", online: true }], projects: [{ id: "btc", name: "BTC", state: { control: { paused: false }, runtime: { status: "assistant", progressKey: "assistant|x|finished|idle|y", lastSeenAt: Date.now() } }, worker: { id: "shared", online: true } }] }; },
    async action(projectId, action) { calls.push([projectId, action]); return { ok: true, projectId, action, state: {} }; },
    async restartAll() { if (restartBlocked) { const e = new Error("restart_blocked:btc"); e.status = 409; throw e; } calls.push(["restartAll"]); return { ok: true, restarting: ["shared"] }; }
  };
  const server = await createControlServer({
    host: "127.0.0.1", port: 0, projects: [], runtimeStore: null, progressWatchdog: null,
    logger: { info() {}, error() {} }, telegramBotToken: "123:test", telegramOwnerUserId: "42",
    miniappDir: miniapp(), controlRegistry: registry
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, mode: "control_hub", workers: 0 });
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  const headers = { authorization: `tma ${signed("123:test", 42)}`, "content-type": "application/json" };
  const status = await fetch(`${base}/api/status`, { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).projects[0].id, "btc");
  const pause = await fetch(`${base}/api/projects/btc/action`, { method: "POST", headers, body: JSON.stringify({ action: "pause" }) });
  assert.equal(pause.status, 200);
  assert.deepEqual(calls[0], ["btc", "pause"]);
  const restart = await fetch(`${base}/api/service/restart`, { method: "POST", headers, body: "{}" });
  assert.equal(restart.status, 202);
  assert.deepEqual(calls[1], ["restartAll"]);
  restartBlocked = true;
  const blocked = await fetch(`${base}/api/service/restart`, { method: "POST", headers, body: "{}" });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /restart_blocked/);
});
