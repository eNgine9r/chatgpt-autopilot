import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexProjectBackend } from "../src/codex-backend.mjs";
import { loadCodexState, saveCodexState } from "../src/codex-state-store.mjs";

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.requests = [];
  }

  async start() {}

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thr_123", status: { type: "idle" } } };
    }
    if (method === "thread/resume") {
      return { thread: { id: params.threadId, status: { type: "idle" } } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn_1", status: "inProgress" } };
    }
    throw new Error(`unexpected:${method}`);
  }

  async close() {}
}

function fixture() {
  const client = new FakeClient();
  const messages = [];
  const observations = [];
  const project = {
    id: "worker",
    name: "Worker Project",
    backend: "codex",
    repoPath: "/srv/project",
    continuationPrompt: "Continue safely",
    completionSettleSeconds: 2,
    userGateMarker: "[[USER_ACTION_REQUIRED]]",
    codex: {
      approvalPolicy: "on-request",
      networkAccess: false,
      autoContinue: false
    }
  };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-codex-backend-"));
  const backend = new CodexProjectBackend({
    project,
    stateDir,
    notifier: { send: async (text) => { messages.push(text); return true; } },
    logger: { info() {}, error() {} },
    progressWatchdog: {
      observe: (id, value) => observations.push({ id, value })
    },
    clientFactory: () => client
  });
  return { backend, client, messages, observations, stateDir };
}

test("starts a Codex thread and launches a constrained turn", async () => {
  const { backend, client, observations } = fixture();
  const state = await backend.start();
  assert.equal(state.threadId, "thr_123");
  assert.equal(state.status, "idle");
  assert.ok(observations.some((item) => item.value.progressKey === "codex_thread:thr_123"));

  assert.equal(await backend.startTurn("Inspect only"), true);
  const turn = client.requests.find((item) => item.method === "turn/start");
  assert.equal(turn.params.threadId, "thr_123");
  assert.equal(turn.params.approvalPolicy, "on-request");
  assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
  assert.deepEqual(turn.params.sandboxPolicy.writableRoots, ["/srv/project"]);
  assert.equal(turn.params.sandboxPolicy.networkAccess, false);
});

test("approval wait pauses the project and alerts once", async () => {
  const { backend, messages } = fixture();
  await backend.start();
  backend.onNotification({
    method: "thread/status/changed",
    params: { status: { type: "active", activeFlags: ["waitingOnApproval"] } }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backend.paused, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /потребує вашої дії/i);

  backend.onNotification({
    method: "thread/status/changed",
    params: { status: { type: "active", activeFlags: ["waitingOnApproval"] } }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
});

test("failed turn pauses and includes the Codex error in Telegram", async () => {
  const { backend, messages } = fixture();
  await backend.start();
  await backend.handleTurnCompleted({
    id: "turn_failed",
    status: "failed",
    error: { message: "Usage limit exceeded until a later date" }
  });
  assert.equal(backend.paused, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Usage limit exceeded/);
});


test("missing rollout on resume self-heals with a fresh idle thread", async () => {
  const { backend, client, stateDir } = fixture();
  saveCodexState(stateDir, "worker", { threadId: "thr_stale" });
  const originalRequest = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === "thread/resume") {
      client.requests.push({ method, params });
      throw new Error("no rollout found for thread id thr_stale");
    }
    return originalRequest(method, params);
  };

  const state = await backend.start();
  assert.equal(state.threadId, "thr_123");
  assert.deepEqual(client.requests.map((item) => item.method), ["thread/resume", "thread/start"]);
  assert.equal(loadCodexState(stateDir, "worker").threadId, "thr_123");
  assert.equal(client.requests.some((item) => item.method === "turn/start"), false);
});

test("unrelated resume failures remain fail-closed", async () => {
  const { backend, client, stateDir } = fixture();
  saveCodexState(stateDir, "worker", { threadId: "thr_stale" });
  client.request = async (method, params) => {
    client.requests.push({ method, params });
    if (method === "thread/resume") throw new Error("authentication failed");
    throw new Error(`unexpected:${method}`);
  };

  await assert.rejects(() => backend.start(), /authentication failed/);
  assert.deepEqual(client.requests.map((item) => item.method), ["thread/resume"]);
});
