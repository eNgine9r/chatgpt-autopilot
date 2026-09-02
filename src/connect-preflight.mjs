import fs from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { waylandSocketPath } from "./chromium-session.mjs";

const execFile = promisify(execFileCallback);

function yesNo(value) {
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

export function parseRpiConnectStatus(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const get = (prefix) => lines.find((line) => line.startsWith(prefix)) || "";
  const signed = get("Signed in:").match(/^Signed in:\s*(yes|no)$/i);
  const subscribed = get("Subscribed to events:").match(/^Subscribed to events:\s*(yes|no)$/i);
  const screen = get("Screen sharing:").match(/^Screen sharing:\s*(allowed|disallowed|unavailable)(?:\s*\((\d+) sessions? active\))?$/i);
  const shell = get("Remote shell:").match(/^Remote shell:\s*(allowed|disallowed|unavailable)(?:\s*\((\d+) sessions? active\))?$/i);
  if (!signed || !subscribed || !screen || !shell) return null;
  return {
    signedIn: yesNo(signed[1].toLowerCase()),
    subscribed: yesNo(subscribed[1].toLowerCase()),
    screenSharing: screen[1].toLowerCase(),
    screenSessions: Number(screen[2] || 0),
    remoteShell: shell[1].toLowerCase(),
    shellSessions: Number(shell[2] || 0)
  };
}

export function readinessDecision({ waylandReady, connectStatus }) {
  if (!waylandReady) return { ready: false, reason: "wayland_not_ready" };
  if (!connectStatus) return { ready: false, reason: "connect_status_unknown" };
  if (connectStatus.signedIn !== true) return { ready: false, reason: "connect_not_signed_in" };
  if (connectStatus.subscribed !== true) return { ready: false, reason: "connect_not_subscribed" };
  if (connectStatus.screenSessions > 0) {
    return { ready: false, reason: "screen_sharing_active", sessions: connectStatus.screenSessions };
  }
  return { ready: true, reason: "ready" };
}

export async function readRpiConnectStatus(config, baseEnv = process.env) {
  const { stdout } = await execFile(config.rpiConnectExecutablePath, ["status"], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
    env: {
      ...baseEnv,
      XDG_RUNTIME_DIR: config.xdgRuntimeDir,
      DBUS_SESSION_BUS_ADDRESS: config.dbusSessionBusAddress,
      WAYLAND_DISPLAY: config.waylandDisplay,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8"
    }
  });
  return parseRpiConnectStatus(stdout);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForStartupReadiness({ config, logger, statusReader = readRpiConnectStatus, sleep = delay }) {
  const timeoutMs = config.connectPreflightTimeoutSeconds * 1000;
  const pollMs = config.connectPreflightPollSeconds * 1000;
  const deadline = Date.now() + timeoutMs;
  let lastReason = "";
  let lastStatus = null;

  while (Date.now() <= deadline) {
    const waylandReady = fs.existsSync(waylandSocketPath(config));
    try { lastStatus = await statusReader(config); } catch { lastStatus = null; }
    const decision = readinessDecision({ waylandReady, connectStatus: lastStatus });
    if (decision.ready) return { ...decision, connectStatus: lastStatus };
    if (decision.reason !== lastReason) {
      logger?.info?.("startup_preflight_wait", { reason: decision.reason, sessions: decision.sessions || 0 });
      lastReason = decision.reason;
    }
    await sleep(pollMs);
  }
  throw new Error(`Startup preflight timed out: ${lastReason || "unknown"}`);
}
