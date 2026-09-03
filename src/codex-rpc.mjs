import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

export function buildCodexTransport(project) {
  const transport = project.codex?.transport || {};
  if (transport.type === "local") {
    return {
      command: transport.executable || "codex",
      args: ["app-server", "--listen", "stdio://"]
    };
  }
  if (transport.type === "ssh") {
    return {
      command: transport.sshExecutable || "/usr/bin/ssh",
      args: [
        "-T",
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=2",
        "-i", transport.identityFile,
        `${transport.user}@${transport.host}`
      ]
    };
  }
  throw new Error(`${project.id}: unsupported Codex transport`);
}

export class CodexRpcClient extends EventEmitter {
  constructor({ command, args = [], logger, spawnFn = spawn, requestTimeoutMs = 30000 }) {
    super();
    this.command = command;
    this.args = args;
    this.logger = logger;
    this.spawnFn = spawnFn;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.closed = false;
  }

  async start() {
    if (this.child) return;
    this.child = this.spawnFn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.logger?.info?.("codex_stderr", { text: text.slice(0, 1000) });
    });
    this.child.once("error", (error) => this.handleExit(error));
    this.child.once("exit", (code, signal) => {
      this.handleExit(new Error(`codex_app_server_exit:${code ?? signal ?? "unknown"}`));
    });

    await this.request("initialize", {
      clientInfo: {
        name: "chatgpt_autopilot",
        title: "ChatGPT Autopilot",
        version: "0.3.0"
      },
      capabilities: {
        optOutNotificationMethods: ["item/agentMessage/delta"]
      }
    });
    this.notify("initialized", {});
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.logger?.error?.("codex_invalid_json", {
        error: String(error),
        line: line.slice(0, 500)
      });
      return;
    }
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && message.id != null) {
      this.emit("serverRequest", message);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  write(message) {
    if (!this.child?.stdin?.writable || this.closed) {
      throw new Error("codex_transport_not_writable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex_request_timeout:${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  handleExit(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("exit", error);
  }

  async close() {
    if (!this.child || this.closed) return;
    this.closed = true;
    this.child.kill("SIGTERM");
  }
}
