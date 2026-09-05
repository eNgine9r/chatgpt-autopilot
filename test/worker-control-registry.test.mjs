import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadWorkerRegistry, WorkerControlRegistry } from "../src/worker-control-registry.mjs";

const workers = [
  { id: "shared", name: "Shared", baseUrl: "http://127.0.0.1:8765", projects: [{ id: "btc", name: "BTC" }, { id: "nexo", name: "Nexo" }], restartServices: ["chatgpt-project-autopilot.service"] },
  { id: "dev", name: "Dev", baseUrl: "http://127.0.0.1:8767", projects: [{ id: "autopilot", name: "Autopilot" }], restartServices: ["chatgpt-autopilot-dev-browser.service"] }
];

function project(id, key = `assistant|${id}|finished|idle|x`, status = "assistant", seen = 100000, paused = false) {
  return { id, name: id, state: { control: { paused }, runtime: { progressKey: key, status, lastSeenAt: seen }, checkpoint: {}, recovery: {} } };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
test("registry aggregates workers and keeps offline projects visible", async () => {
  const fetchImpl = async (url) => {
    if (String(url).startsWith("http://127.0.0.1:8765")) return jsonResponse({ projects: [project("btc"), project("nexo")] });
    throw new Error("connection_refused");
  };
  const registry = new WorkerControlRegistry({ workers, fetchImpl, now: () => 100000 });
  const status = await registry.status();
  assert.equal(status.projects.length, 3);
  assert.equal(status.projects.find((p) => p.id === "btc").worker.online, true);
  const dev = status.projects.find((p) => p.id === "autopilot");
  assert.equal(dev.worker.online, false);
  assert.equal(dev.state.runtime.status, "worker_offline");
});

test("project actions route only to the owning worker", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push([String(url), options]);
    return jsonResponse({ ok: true, projectId: "autopilot", action: "pause", state: {} });
  };
  const registry = new WorkerControlRegistry({ workers, fetchImpl });
  await registry.action("autopilot", "pause");
  assert.equal(calls[0][0], "http://127.0.0.1:8767/operator/action");
  assert.deepEqual(JSON.parse(calls[0][1].body), { projectId: "autopilot", action: "pause" });
});
test("full restart is blocked unless every worker project proves fresh idle", async () => {
  let active = true; const restarted = []; const paused = new Set();
  const fetchImpl = async (url, options = {}) => {
    if (String(options.method || "GET") === "POST") {
      const body = JSON.parse(options.body); if (body.action === "pause") paused.add(body.projectId);
      return jsonResponse({ ok: true, projectId: body.projectId, action: body.action, state: {} });
    }
    const ids = String(url).includes(":8765") ? ["btc", "nexo"] : ["autopilot"];
    const projects = ids.map((id) => id === "nexo" && active
      ? project(id, `assistant|${id}|unknown|generating|x`, "working", 99000, paused.has(id))
      : project(id, undefined, "assistant", paused.has(id) ? 99500 : 99000, paused.has(id)));
    return jsonResponse({ projects });
  };
  const registry = new WorkerControlRegistry({ workers, fetchImpl, now: () => 100000, restartWorker: async (worker) => restarted.push(worker.id) });
  await assert.rejects(() => registry.restartAll(), /restart_blocked:nexo/);
  assert.deepEqual(restarted, []);
  assert.deepEqual([...paused], []);
  active = false;
  const result = await registry.restartAll();
  assert.deepEqual(result.restarting, ["shared", "dev"]);
  assert.deepEqual(result.pausedProjects.sort(), ["autopilot", "btc", "nexo"]);
  assert.equal(result.projectsRemainPaused, true);
  assert.deepEqual(restarted, ["shared", "dev"]);
});

test("restart barrier catches a generation that starts after the first idle snapshot", async () => {
  const restarted = []; const paused = new Set(); let statusReads = 0;
  const fetchImpl = async (url, options = {}) => {
    if (String(options.method || "GET") === "POST") {
      const body = JSON.parse(options.body); if (body.action === "pause") paused.add(body.projectId);
      return jsonResponse({ ok: true, projectId: body.projectId, action: body.action, state: {} });
    }
    statusReads += 1;
    const afterPause = paused.size > 0;
    const ids = String(url).includes(":8765") ? ["btc", "nexo"] : ["autopilot"];
    const projects = ids.map((id) => afterPause && id === "nexo"
      ? project(id, `assistant|${id}|unknown|generating|x`, "working", 99500, true)
      : project(id, undefined, "assistant", afterPause ? 99500 : 99000, afterPause));
    return jsonResponse({ projects });
  };
  const registry = new WorkerControlRegistry({
    workers, fetchImpl, now: () => 100000, restartWorker: async (worker) => restarted.push(worker.id),
    restartBarrierTimeoutMs: 0
  });
  await assert.rejects(() => registry.restartAll(), /restart_barrier_failed:nexo/);
  assert.deepEqual(restarted, []);
  assert.deepEqual([...paused].sort(), ["autopilot", "btc", "nexo"]);
  assert.ok(statusReads >= 4);
});

test("worker registry rejects non-loopback endpoints and duplicate projects", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-workers-"));
  const file = path.join(root, "workers.json");
  fs.writeFileSync(file, JSON.stringify({ workers: [{ id: "bad", baseUrl: "https://example.com", projects: [{ id: "x" }] }] }));
  assert.throws(() => loadWorkerRegistry(file), /loopback/);
  fs.writeFileSync(file, JSON.stringify({ workers: [
    { id: "a", baseUrl: "http://127.0.0.1:1", projects: [{ id: "x" }] },
    { id: "b", baseUrl: "http://127.0.0.1:2", projects: [{ id: "x" }] }
  ] }));
  assert.throws(() => loadWorkerRegistry(file), /duplicate_project/);
});
