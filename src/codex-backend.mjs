import { CodexRpcClient, buildCodexTransport } from "./codex-rpc.mjs";
import { loadCodexState, saveCodexState } from "./codex-state-store.mjs";

function statusType(status) {
  return String(status?.type || "unknown");
}

function isMissingRolloutError(error) {
  return /no rollout found for thread id/i.test(String(error?.message || error || ""));
}

function progressKey(message) {
  const { method, params = {} } = message;
  if (method === "turn/started" || method === "turn/completed") {
    return `${method}:${params.turn?.id || ""}:${params.turn?.status || ""}`;
  }
  if (method === "item/completed") {
    return `${method}:${params.item?.id || ""}:${params.item?.type || ""}:${params.item?.status || ""}`;
  }
  if (method === "turn/plan/updated") {
    return `${method}:${JSON.stringify(params.plan || []).slice(0, 400)}`;
  }
  if (method === "thread/status/changed") {
    const flags = Array.isArray(params.status?.activeFlags) ? params.status.activeFlags.join(",") : "";
    return `${method}:${statusType(params.status)}:${flags}`;
  }
  return "";
}

export class CodexProjectBackend {
  constructor({ project, stateDir, notifier, logger, progressWatchdog, clientFactory = null }) {
    this.project = project;
    this.stateDir = stateDir;
    this.notifier = notifier;
    this.logger = logger;
    this.progressWatchdog = progressWatchdog;
    this.clientFactory = clientFactory;
    this.client = null;
    this.threadId = "";
    this.activeTurnId = "";
    this.paused = false;
    this.approvalAlerted = false;
    this.nextTurnTimer = null;
    this.lastAgentText = "";
  }

  makeClient() {
    if (this.clientFactory) return this.clientFactory(this.project);
    const transport = buildCodexTransport(this.project);
    return new CodexRpcClient({ ...transport, logger: this.logger });
  }

  threadOptions() {
    const options = {
      cwd: this.project.repoPath,
      approvalPolicy: this.project.codex?.approvalPolicy || "on-request",
      sandbox: "workspace-write",
      serviceName: "chatgpt_autopilot"
    };
    if (this.project.codex?.model) options.model = this.project.codex.model;
    if (this.project.codex?.personality) options.personality = this.project.codex.personality;
    return options;
  }

  turnOptions() {
    const options = {
      cwd: this.project.repoPath,
      approvalPolicy: this.project.codex?.approvalPolicy || "on-request"
    };
    options.sandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: [this.project.repoPath],
      networkAccess: this.project.codex?.networkAccess === true
    };
    if (this.project.codex?.model) options.model = this.project.codex.model;
    if (this.project.codex?.effort) options.effort = this.project.codex.effort;
    if (this.project.codex?.personality) options.personality = this.project.codex.personality;
    options.summary = "concise";
    return options;
  }

  async start() {
    this.client = this.makeClient();
    this.client.on("notification", (message) => this.onNotification(message));
    this.client.on("serverRequest", (message) => this.onServerRequest(message));
    this.client.on("exit", (error) => this.onExit(error));
    await this.client.start();

    const state = loadCodexState(this.stateDir, this.project.id);
    let result;
    if (state.threadId) {
      try {
        result = await this.client.request("thread/resume", {
          threadId: state.threadId,
          ...this.threadOptions()
        });
      } catch (error) {
        if (!isMissingRolloutError(error)) throw error;
        this.logger.info("codex_thread_resume_missing_rollout", {
          project: this.project.name
        });
        result = await this.client.request("thread/start", this.threadOptions());
      }
    } else {
      result = await this.client.request("thread/start", this.threadOptions());
    }

    this.threadId = String(result?.thread?.id || state.threadId || "");
    if (!this.threadId) throw new Error(`${this.project.id}: Codex did not return a thread id`);
    saveCodexState(this.stateDir, this.project.id, {
      threadId: this.threadId,
      updatedAt: new Date().toISOString()
    });
    this.progressWatchdog?.observe(this.project.id, {
      progressKey: `codex_thread:${this.threadId}`,
      status: statusType(result?.thread?.status)
    });
    this.logger.info("codex_backend_ready", {
      project: this.project.name,
      threadId: this.threadId,
      status: statusType(result?.thread?.status)
    });

    return {
      threadId: this.threadId,
      status: statusType(result?.thread?.status)
    };
  }

  async startTurn(prompt) {
    if (this.paused || this.activeTurnId) return false;
    const text = String(prompt || "").trim();
    if (!text) throw new Error(`${this.project.id}: empty Codex turn prompt`);
    const result = await this.client.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text }],
      ...this.turnOptions()
    });
    this.activeTurnId = String(result?.turn?.id || "");
    this.logger.info("codex_turn_started", {
      project: this.project.name,
      threadId: this.threadId,
      turnId: this.activeTurnId
    });
    return true;
  }

  onNotification(message) {
    const key = progressKey(message);
    this.progressWatchdog?.observe(this.project.id, {
      progressKey: key,
      status: message.method
    });

    if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
      this.lastAgentText = String(message.params.item.text || "");
      if (this.lastAgentText.includes(this.project.userGateMarker)) {
        this.pauseForUser("agent_marker");
      }
    }

    if (message.method === "thread/status/changed") {
      const status = message.params?.status || {};
      const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
      if (flags.includes("waitingOnApproval")) this.pauseForUser("approval_wait");
    }

    if (message.method === "turn/completed") {
      void this.handleTurnCompleted(message.params?.turn || {});
    }
  }

  onServerRequest(message) {
    this.logger.info("codex_server_request", {
      project: this.project.name,
      method: message.method,
      requestId: message.id
    });
    this.pauseForUser(`server_request:${message.method}`);
  }

  pauseForUser(reason) {
    if (this.paused && this.approvalAlerted) return;
    this.paused = true;
    this.approvalAlerted = true;
    const text = `⚠️ ${this.project.name}: Codex потребує вашої дії.\nПричина: ${reason}.\nThread: ${this.threadId}`;
    void this.notifier.send(text);
    this.logger.info("codex_user_gate", {
      project: this.project.name,
      threadId: this.threadId,
      reason
    });
  }

  async handleTurnCompleted(turn) {
    this.activeTurnId = "";
    const status = String(turn.status || "unknown");
    if (status !== "completed") {
      this.paused = true;
      const detail = String(turn.error?.message || "").trim().slice(0, 700);
      await this.notifier.send(
        `🔴 ${this.project.name}: Codex turn завершився зі статусом ${status}.\n${detail ? `${detail}\n` : ""}Thread: ${this.threadId}`
      );
      return;
    }
    if (this.paused || this.project.codex?.autoContinue === false) return;
    const delayMs = Math.max(2, Number(this.project.completionSettleSeconds || 10)) * 1000;
    clearTimeout(this.nextTurnTimer);
    this.nextTurnTimer = setTimeout(() => {
      this.nextTurnTimer = null;
      this.startTurn(this.project.continuationPrompt).catch((error) => {
        this.logger.error("codex_auto_continue_failed", {
          project: this.project.name,
          error: String(error)
        });
        void this.notifier.send(
          `🔴 ${this.project.name}: не вдалося продовжити Codex thread.\n${String(error).slice(0, 500)}`
        );
      });
    }, delayMs);
    this.nextTurnTimer.unref?.();
  }

  onExit(error) {
    this.logger.error("codex_backend_exited", {
      project: this.project.name,
      error: String(error)
    });
    void this.notifier.send(
      `🔴 ${this.project.name}: втрачено зв’язок із Codex App Server.\n${String(error).slice(0, 500)}`
    );
  }

  async close() {
    clearTimeout(this.nextTurnTimer);
    this.nextTurnTimer = null;
    await this.client?.close();
  }
}
