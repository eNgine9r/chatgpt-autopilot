import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadDotEnv } from "./env.mjs";
import { loadRuntimeConfig, loadProjects } from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { TelegramNotifier } from "./notifier.mjs";
import { createBridgeServer } from "./bridge.mjs";
import { buildStartupPlan } from "./startup.mjs";

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
const enabled = projects.filter((project) => project.enabled);
if (!enabled.length) throw new Error("No enabled projects in config/projects.json");
const startupPlan = buildStartupPlan(enabled, config.projectStartupStaggerSeconds);

for (const dir of [config.browserProfileDir, config.logDir]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const notifier = new TelegramNotifier({
  token: config.telegramBotToken,
  chatId: config.telegramChatId,
  logger
});

const bridge = await createBridgeServer({
  host: config.bridgeHost,
  port: config.bridgePort,
  projects,
  projectsFile: config.projectsFile,
  notifier,
  logger
});

const browserLogPath = path.join(config.logDir, "chromium.log");
const browserLogFd = fs.openSync(browserLogPath, "a", 0o600);
const args = [
  `--user-data-dir=${config.browserProfileDir}`,
  `--load-extension=${config.extensionDir}`,
  `--disable-extensions-except=${config.extensionDir}`,
  "--no-first-run",
  "--disable-session-crashed-bubble",
  "--new-window",
  startupPlan[0].project.chatUrl
];

const browserEnv = {
  ...process.env,
  DISPLAY: config.display,
  ...(config.xauthority ? { XAUTHORITY: config.xauthority } : {})
};

let shuttingDown = false;
const startupTimers = new Set();

const browser = spawn(config.chromiumExecutablePath, args, {
  env: browserEnv,
  stdio: ["ignore", browserLogFd, browserLogFd]
});

logger.info("autopilot_started", {
  chromiumPid: browser.pid,
  projects: startupPlan.map(({ project }) => project.name),
  startupStaggerSeconds: config.projectStartupStaggerSeconds,
  primaryProject: startupPlan[0].project.name,
  telegram: notifier.enabled,
  display: config.display
});

for (const entry of startupPlan.slice(1)) {
  const timer = setTimeout(() => {
    startupTimers.delete(timer);
    if (shuttingDown || browser.exitCode != null) return;
    const opener = spawn(config.chromiumExecutablePath, [
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
  logger.info("shutdown", { signal });
  await new Promise((resolve) => bridge.close(resolve));
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
  process.exit(1);
});

process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT", () => shutdown("SIGINT", 0));
