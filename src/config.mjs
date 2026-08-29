import fs from "node:fs";
import path from "node:path";

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

export function resolveFromCwd(value) {
  return path.resolve(process.cwd(), value);
}

export function loadRuntimeConfig() {
  return {
    headless: boolEnv("HEADLESS", true),
    checkIntervalMs: Math.max(1000, intEnv("CHECK_INTERVAL_MS", 2000)),
    errorNotifyAfter: Math.max(1, intEnv("ERROR_NOTIFY_AFTER", 3)),
    recoveryNotify: boolEnv("RECOVERY_NOTIFY", true),
    browserProfileDir: resolveFromCwd(process.env.BROWSER_PROFILE_DIR || "./browser-profile"),
    stateDir: resolveFromCwd(process.env.STATE_DIR || "./state"),
    logDir: resolveFromCwd(process.env.LOG_DIR || "./logs"),
    projectsFile: resolveFromCwd(process.env.PROJECTS_FILE || "./config/projects.json"),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || ""
  };
}

export function loadProjects(projectsFile) {
  const raw = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
  if (!Array.isArray(raw.projects)) throw new Error("config.projects must be an array");

  const ids = new Set();
  return raw.projects.map((project) => {
    if (!project.id || !project.name || !project.chatUrl) {
      throw new Error("Each project requires id, name and chatUrl");
    }
    if (ids.has(project.id)) throw new Error(`Duplicate project id: ${project.id}`);
    ids.add(project.id);

    const continueAfterSeconds = Number(project.continueAfterSeconds ?? 1480);
    if (!Number.isFinite(continueAfterSeconds) || continueAfterSeconds < 60) {
      throw new Error(`${project.id}: continueAfterSeconds must be >= 60`);
    }

    return {
      enabled: project.enabled !== false,
      userGateMarker: project.userGateMarker || "[[USER_ACTION_REQUIRED]]",
      continuationPrompt: String(project.continuationPrompt || "").trim(),
      ...project,
      continueAfterSeconds
    };
  });
}
