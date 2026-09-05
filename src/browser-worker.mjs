import { loadDotEnv } from "./env.mjs";
import { loadRuntimeConfig, loadProjects } from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { TelegramNotifier } from "./notifier.mjs";
import { createBridgeServer } from "./bridge.mjs";
import { SupervisorProgressWatchdog } from "./progress-watchdog.mjs";
import { ProjectRuntimeStore } from "./runtime-store.mjs";

loadDotEnv();
const config = loadRuntimeConfig();
const logger = createLogger(config.logDir);
const projects = loadProjects(config.projectsFile);
const enabled = projects.filter((project) => project.enabled && project.backend === "browser");
if (!enabled.length) throw new Error("browser_worker_requires_enabled_project");
const port = Number(process.env.WORKER_BRIDGE_PORT || 8767);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid_worker_bridge_port");
const notifier = new TelegramNotifier({ token: config.telegramBotToken, chatId: config.telegramChatId, logger });
const runtimeStore = new ProjectRuntimeStore({ stateDir: config.stateDir, projects: enabled });
const watchdog = new SupervisorProgressWatchdog({ projects: enabled, notifier, logger, runtimeStore });
const server = await createBridgeServer({
  host: "127.0.0.1", port, projects: enabled, projectsFile: config.projectsFile,
  notifier, logger, progressWatchdog: watchdog, runtimeStore
});
const timer = setInterval(() => {
  watchdog.check().catch((error) => logger.error("browser_worker_watchdog_failed", { error: String(error) }));
}, Math.max(5, config.supervisorWatchdogPollSeconds) * 1000);
timer.unref();
logger.info("browser_worker_started", { port, projects: enabled.map((project) => project.name) });
async function shutdown(signal) {
  clearInterval(timer);
  logger.info("browser_worker_shutdown", { signal });
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
