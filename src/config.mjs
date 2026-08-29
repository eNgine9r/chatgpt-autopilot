import fs from "node:fs";
import path from "node:path";

export function resolveFromCwd(value) {
  return path.resolve(process.cwd(), value);
}

export function loadRuntimeConfig() {
  return {
    chromiumExecutablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
    display: process.env.DISPLAY || ":0",
    xauthority: process.env.XAUTHORITY || "",
    browserProfileDir: resolveFromCwd(process.env.BROWSER_PROFILE_DIR || "./browser-profile"),
    logDir: resolveFromCwd(process.env.LOG_DIR || "./logs"),
    projectsFile: resolveFromCwd(process.env.PROJECTS_FILE || "./config/projects.json"),
    extensionDir: resolveFromCwd("./extension"),
    bridgeHost: "127.0.0.1",
    bridgePort: 8765,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || ""
  };
}

export function normalizeChatUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") {
    throw new Error(`Unsupported ChatGPT URL: ${raw}`);
  }
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.origin}${pathname}`;
}

export function loadProjects(projectsFile) {
  const raw = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
  if (!Array.isArray(raw.projects)) throw new Error("config.projects must be an array");

  const ids = new Set();
  return raw.projects.map((project) => {
    if (!project.id || !project.name || !project.chatUrl) {
      throw new Error("Each project requires id, name and chatUrl");
    }
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(project.id)) {
      throw new Error(`${project.id}: invalid project id`);
    }
    if (ids.has(project.id)) throw new Error(`Duplicate project id: ${project.id}`);
    ids.add(project.id);

    const continueAfterSeconds = Number(project.continueAfterSeconds ?? 1480);
    if (!Number.isFinite(continueAfterSeconds) || continueAfterSeconds < 60) {
      throw new Error(`${project.id}: continueAfterSeconds must be >= 60`);
    }

    const continuationPrompt = String(project.continuationPrompt || "").trim();
    if (!continuationPrompt) throw new Error(`${project.id}: continuationPrompt is required`);

    return {
      id: String(project.id),
      name: String(project.name),
      enabled: project.enabled !== false,
      chatUrl: normalizeChatUrl(project.chatUrl),
      continueAfterSeconds,
      userGateMarker: String(project.userGateMarker || "[[USER_ACTION_REQUIRED]]"),
      continuationPrompt
    };
  });
}

export function publicProjects(projects) {
  return projects.filter((project) => project.enabled).map((project) => ({ ...project }));
}
