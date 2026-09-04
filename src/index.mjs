import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadDotEnv } from "./env.mjs";
import { loadRuntimeConfig, loadProjects } from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { TelegramNotifier } from "./notifier.mjs";
import { createBridgeServer } from "./bridge.mjs";
import { SupervisorProgressWatchdog } from "./progress-watchdog.mjs";
import { buildStartupPlan } from "./startup.mjs";
import { buildChromiumEnvironment, chromiumPlatformArgs } from "./chromium-session.mjs";
import { waitForStartupReadiness } from "./connect-preflight.mjs";
import { listOwnedGcrPrompterPids, watchAndDismissNewGcrPrompters } from "./keyring-prompt.mjs";
import { ProjectRuntimeStore } from "./runtime-store.mjs";
import { createControlServer } from "./control-server.mjs";

loadDotEnv();
const config = loadRuntimeConfig();
const logger = createLogger(config.logDir);

if (!fs.existsSync(config.projectsFile)) {
  throw new Error(`Missing ${config.projectsFile}. Copy config/projects.example.json to config/projects.json`);
}
if (!fs.existsSync(config.chromiumExecutablePath)) {
  throw new Error(`Chromium executable not found: ${config.chromiumExecutablePath}`);
}
const projects = loadProjects(config.projectsFile);
const enabled = projects.filter((project) => project.enabled && project.backend === "browser");
if (!enabled.length) throw new Error("No enabled projects in config/projects.json");
const startupPlan = buildStartupPlan(enabled, config.projectStartupStaggerSeconds);

for (const dir of [config.browserProfileDir, config.logDir, config.stateDir]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const preflight = await waitForStartupReadiness({ config, logger });
logger.info("startup_preflight_ready", {
  screenSessions: preflight.connectStatus.screenSessions,
  shellSessions: preflight.connectStatus.shellSessions
});

const notifier = new TelegramNotifier({
  token: config.telegramBotToken,
  chatId: config.telegramChatId,
  logger
});

const runtimeStore = new ProjectRuntimeStore({ stateDir: config.stateDir, projects: enabled });
const progressWatchdog = new SupervisorProgressWatchdog({ projects: enabled, notifier, logger, runtimeStore });
const bridge = await createBridgeServer({
  host: config.bridgeHost,
  port: config.bridgePort,
  projects: enabled,
  projectsFile: config.projectsFile,
  notifier,
  logger,
  progressWatchdog,
  runtimeStore,
  onBrowserRestart: ({ projectId, reason }) => {
    logger.info("browser_recovery_supervisor_restart", { projectId, reason });
    shutdown("browser_recovery_restart", 1);
  }
});

let controlServer = null;
if (config.telegramBotToken && config.telegramOwnerUserId) {
  controlServer = await createControlServer({
    host: config.controlHost,
    port: config.controlPort,
    projects: enabled,
    runtimeStore,
    progressWatchdog,
    logger,
    telegramBotToken: config.telegramBotToken,
    telegramOwnerUserId: config.telegramOwnerUserId,
    miniappDir: config.miniappDir,
    onServiceRestart: () => shutdown("control_restart", 1)
  });
  logger.info("control_server_started", { host: config.controlHost, port: config.controlPort });
}

const progressWatchdogTimer = setInterval(() => {
  progressWatchdog.check().catch((error) => {
    logger.error("supervisor_watchdog_failed", { error: String(error) });
  });
}, Math.max(5, config.supervisorWatchdogPollSeconds) * 1000);
progressWatchdogTimer.unref();

const browserLogPath = path.join(config.logDir, "chromium.log");
const browserLogFd = fs.openSync(browserLogPath, "a", 0o600);
const args = [
  ...chromiumPlatformArgs(config),
  `--user-data-dir=${config.browserProfileDir}`,
  `--load-extension=${config.extensionDir}`,
  `--disable-extensions-except=${config.extensionDir}`,
  "--no-first-run",
  "--disable-session-crashed-bubble",
  "--new-window",
  startupPlan[0].project.chatUrl
];

const browserEnv = buildChromiumEnvironment(config, process.env);

let shuttingDown = false;
const startupTimers = new Set();
let keyringPromptBaselinePids = null;
if (config.keyringPromptAutoCancel) {
  try {
    keyringPromptBaselinePids = listOwnedGcrPrompterPids();
    logger.info("keyring_prompt_baseline", { count: keyringPromptBaselinePids.length });
  } catch (error) {
    logger.error("keyring_prompt_baseline_failed", { error: String(error) });
  }
}

const browser = spawn(config.chromiumExecutablePath, args, {
  env: browserEnv,
  stdio: ["ignore", browserLogFd, browserLogFd]
});

if (config.keyringPromptAutoCancel && keyringPromptBaselinePids) {
  void watchAndDismissNewGcrPrompters({
    // The automation account is dedicated to this browser. Cancel any already-open
    // same-user keyring prompt as well as prompts created after Chromium starts.
    baselinePids: [],
    logger,
    pollMs: config.keyringPromptPollMs,
    timeoutMs: config.keyringPromptWatchSeconds * 1000,
    shouldStop: () => shuttingDown || browser.exitCode != null
  }).then((cancelledPids) => {
    logger.info("keyring_prompt_watch_complete", { cancelled: cancelledPids.length });
  }).catch((error) => {
    logger.error("keyring_prompt_watch_failed", { error: String(error) });
  });
}

logger.info("autopilot_started", {
  chromiumPid: browser.pid,
  projects: startupPlan.map(({ project }) => project.name),
  startupStaggerSeconds: config.projectStartupStaggerSeconds,
  primaryProject: startupPlan[0].project.name,
  telegram: notifier.enabled,
  display: config.display,
  waylandDisplay: config.waylandDisplay,
  xdgRuntimeDir: config.xdgRuntimeDir
});

for (const entry of startupPlan.slice(1)) {
  const timer = setTimeout(() => {
    startupTimers.delete(timer);
    if (shuttingDown || browser.exitCode != null) return;
    const opener = spawn(config.chromiumExecutablePath, [
      ...chromiumPlatformArgs(config),
      `--user-data-dir=${config.browserProfileDir}`,
      "--new-tab",
      entry.project.chatUrl
    ], { env: browserEnv, stdio: ["ignore", browserLogFd, browserLogFd] });
    opener.on("error", (error) => {
      logger.error("project_tab_open_failed", { project: entry.project.name, error: String(error) });
    });
    logger.info("project_tab_open_requested", {
      project: entry.project.name,
      delayMs: entry.delayMs
    });
  }, entry.delayMs);
  startupTimers.add(timer);
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const timer of startupTimers) clearTimeout(timer);
  startupTimers.clear();
  clearInterval(progressWatchdogTimer);
  logger.info("shutdown", { signal });
  await new Promise((resolve) => bridge.close(resolve));
  if (controlServer) await new Promise((resolve) => controlServer.close(resolve));
  if (browser.exitCode == null) {
    browser.kill("SIGTERM");
    setTimeout(() => {
      if (browser.exitCode == null) browser.kill("SIGKILL");
    }, 10000).unref();
  }
  setTimeout(() => process.exit(exitCode), 11000).unref();
}

browser.on("error", async (error) => {
  logger.error("chromium_spawn_failed", { error: String(error) });
  await notifier.send(`🔴 ChatGPT Autopilot: Chromium failed to start.\n${String(error).slice(0, 500)}`);
  await shutdown("chromium_error", 1);
});

browser.on("exit", async (code, signal) => {
  if (shuttingDown) return;
  logger.error("chromium_exited", { code, signal });
  await notifier.send(`🔴 ChatGPT Autopilot: Chromium exited unexpectedly (${code ?? signal ?? "unknown"}).`);
  await new Promise((resolve) => bridge.close(resolve));
  if (controlServer) await new Promise((resolve) => controlServer.close(resolve));
  process.exit(1);
});

process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT", () => shutdown("SIGINT", 0));
