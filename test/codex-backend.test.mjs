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
    this.responses = [];
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

  respond(id, result) {
    this.responses.push({ id, result });
  }

  async close() {}
}

function fixture() {
  const client = new FakeClient();
  const messages = [];
  const observations = [];
  const logs = [];
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
      autoContinue: false,
      waitSeconds: 300
    }
  };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-codex-backend-"));
  const backend = new CodexProjectBackend({
    project,
    stateDir,
    notifier: { send: async (text) => { messages.push(text); return true; } },
    logger: { info: (message, data) => logs.push({ message, data }), error() {} },
    progressWatchdog: {
      observe: (id, value) => observations.push({ id, value })
    },
    clientFactory: () => client
  });
  return { backend, client, messages, observations, logs, stateDir };
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

test("approval wait notification is observational until the server request arrives", async () => {
  const { backend, messages, logs } = fixture();
  await backend.start();
  backend.onNotification({
    method: "thread/status/changed",
    params: { status: { type: "active", activeFlags: ["waitingOnApproval"] } }
  });
  assert.equal(backend.paused, false);
  assert.equal(messages.length, 0);
  assert.ok(logs.some((row) => row.message === "codex_approval_wait_observed"));
});

test("command and file escalation requests are declined without pausing", async () => {
  const { backend, client, messages } = fixture();
  await backend.start();
  backend.onServerRequest({ id: 41, method: "item/commandExecution/requestApproval", params: {} });
  backend.onServerRequest({ id: 42, method: "item/fileChange/requestApproval", params: {} });
  assert.deepEqual(client.responses, [
    { id: 41, result: { decision: "decline" } },
    { id: 42, result: { decision: "decline" } }
  ]);
  assert.equal(backend.paused, false);
  assert.equal(messages.length, 0);
});

test("permission escalation is denied with an empty granted subset", async () => {
  const { backend, client, messages } = fixture();
  await backend.start();
  backend.onServerRequest({ id: 43, method: "item/permissions/requestApproval", params: {} });
  assert.deepEqual(client.responses, [{ id: 43, result: { permissions: {} } }]);
  assert.equal(backend.paused, false);
  assert.equal(messages.length, 0);
});

test("unknown server requests remain a user gate", async () => {
  const { backend, messages } = fixture();
  await backend.start();
  backend.onServerRequest({ id: 44, method: "openai/form", params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backend.paused, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /потребує вашої дії/i);
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


test("marker-driven completion stops without another Codex turn", async () => {
  const { backend, logs } = fixture();
  backend.project.codex.autoContinue = true;
  await backend.start();
  backend.lastAgentText = "Current work is done. [[AUTOPILOT_COMPLETE]]";
  await backend.handleTurnCompleted({ status: "completed" });
  assert.equal(backend.nextTurnTimer, null);
  assert.ok(logs.some((row) => row.message === "codex_autopilot_complete"));
});

test("marker-driven wait schedules a long external-evidence poll", async () => {
  const { backend, logs } = fixture();
  backend.project.codex.autoContinue = true;
  backend.project.codex.waitSeconds = 600;
  await backend.start();
  backend.lastAgentText = "CI is still running. [[AUTOPILOT_WAIT]]";
  await backend.handleTurnCompleted({ status: "completed" });
  assert.ok(backend.nextTurnTimer);
  const scheduled = logs.find((row) => row.message === "codex_autopilot_scheduled");
  assert.equal(scheduled.data.directive, "wait");
  assert.equal(scheduled.data.delaySeconds, 600);
  await backend.close();
});


test("marker-driven continue schedules only the next bounded turn", async () => {
  const { backend, logs } = fixture();
  backend.project.codex.autoContinue = true;
  await backend.start();
  backend.lastAgentText = "A concrete safe follow-up remains. [[AUTOPILOT_CONTINUE]]";
  await backend.handleTurnCompleted({ status: "completed" });
  assert.ok(backend.nextTurnTimer);
  const scheduled = logs.find((row) => row.message === "codex_autopilot_scheduled");
  assert.equal(scheduled.data.directive, "continue");
  assert.equal(scheduled.data.delaySeconds, 2);
  await backend.close();
});

test("missing completion marker fails closed instead of looping", async () => {
  const { backend, messages } = fixture();
  backend.project.codex.autoContinue = true;
  await backend.start();
  backend.lastAgentText = "No machine directive supplied";
  await backend.handleTurnCompleted({ status: "completed" });
  assert.equal(backend.paused, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /потребує вашої дії/i);
});
