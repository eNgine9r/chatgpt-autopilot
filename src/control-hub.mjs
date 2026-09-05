import path from "node:path";
import { loadDotEnv } from "./env.mjs";
import { createLogger } from "./logger.mjs";
import { createControlServer } from "./control-server.mjs";
import { loadWorkerRegistry, WorkerControlRegistry } from "./worker-control-registry.mjs";
import { restartWorkerServices } from "./worker-restart.mjs";

loadDotEnv();
const root = process.cwd();
const host = process.env.CONTROL_HUB_HOST || "127.0.0.1";
const port = Number(process.env.CONTROL_HUB_PORT || 8769);
const registryFile = path.resolve(root, process.env.CONTROL_WORKERS_FILE || "./config/control-workers.json");
const miniappDir = path.resolve(root, process.env.MINIAPP_DIR || "./web/miniapp");
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramOwnerUserId = process.env.TELEGRAM_OWNER_USER_ID || "";
if (!telegramBotToken || !telegramOwnerUserId) throw new Error("Telegram owner auth is required for control hub");

const logger = createLogger(path.resolve(root, process.env.LOG_DIR || "./logs"));
const workers = loadWorkerRegistry(registryFile);
const registry = new WorkerControlRegistry({ workers, restartWorker: (worker) => restartWorkerServices(worker) });
const server = await createControlServer({
  host, port, projects: [], runtimeStore: null, progressWatchdog: null, logger,
  telegramBotToken, telegramOwnerUserId, miniappDir, controlRegistry: registry
});
logger.info("control_hub_started", { host, port, workers: workers.map((worker) => worker.id) });

async function shutdown(signal) {
  logger.info("control_hub_shutdown", { signal });
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
