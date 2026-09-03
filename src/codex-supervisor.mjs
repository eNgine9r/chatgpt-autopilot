import fs from "node:fs";
import { loadDotEnv } from "./env.mjs";
import { loadRuntimeConfig, loadProjects } from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { TelegramNotifier } from "./notifier.mjs";
import { SupervisorProgressWatchdog } from "./progress-watchdog.mjs";
import { CodexProjectBackend } from "./codex-backend.mjs";

loadDotEnv();
const config = loadRuntimeConfig();
const logger = createLogger(config.logDir);

if (!fs.existsSync(config.projectsFile)) {
  throw new Error(`Missing ${config.projectsFile}. Copy config/projects.example.json to config/projects.json`);
}
const projects = loadProjects(config.projectsFile);
const enabled = projects.filter((project) => project.enabled && project.backend === "codex");
if (!enabled.length) throw new Error("No enabled Codex projects in config/projects.json");

for (const dir of [config.logDir, config.stateDir]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const notifier = new TelegramNotifier({
  token: config.telegramBotToken,
  chatId: config.telegramChatId,
  logger
});

const progressWatchdog = new SupervisorProgressWatchdog({
  projects: enabled,
  notifier,
  logger
});
const backends = [];

for (const project of enabled) {
  const backend = new CodexProjectBackend({
    project,
    stateDir: config.stateDir,
    notifier,
    logger,
    progressWatchdog
  });
  try {
    const state = await backend.start();
    backends.push(backend);
    logger.info("codex_project_connected", {
      project: project.name,
      threadId: state.threadId,
      status: state.status
    });
    if (project.codex.startOnBoot && state.status !== "active") {
      await backend.startTurn(project.continuationPrompt);
    }
  } catch (error) {
    logger.error("codex_project_start_failed", {
      project: project.name,
      error: String(error)
    });
    await notifier.send(
      `🔴 ${project.name}: не вдалося підключити Codex App Server.\n${String(error).slice(0, 500)}`
    );
  }
}

if (!backends.length) {
  throw new Error("No Codex backends connected successfully");
}

const watchdogTimer = setInterval(() => {
  progressWatchdog.check().catch((error) => {
    logger.error("codex_watchdog_failed", { error: String(error) });
  });
}, Math.max(5, config.supervisorWatchdogPollSeconds) * 1000);
watchdogTimer.unref();

logger.info("codex_supervisor_started", {
  projects: backends.map((backend) => backend.project.name),
  telegram: notifier.enabled
});

let shuttingDown = false;
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(watchdogTimer);
  logger.info("codex_supervisor_shutdown", { signal });
  await Promise.allSettled(backends.map((backend) => backend.close()));
  process.exit(exitCode);
}

process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
process.on("SIGINT", () => void shutdown("SIGINT", 0));
