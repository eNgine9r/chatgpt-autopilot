import fs from "node:fs";
import path from "node:path";

export function resolveFromCwd(value) {
  return path.resolve(process.cwd(), value);
}

export function loadRuntimeConfig() {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  return {
    chromiumExecutablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
    display: process.env.DISPLAY || ":0",
    xauthority: process.env.XAUTHORITY || "",
    xdgRuntimeDir,
    waylandDisplay: process.env.WAYLAND_DISPLAY || "wayland-0",
    dbusSessionBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${xdgRuntimeDir}/bus`,
    chromiumOzonePlatform: process.env.CHROMIUM_OZONE_PLATFORM || "wayland",
    rpiConnectExecutablePath: process.env.RPI_CONNECT_EXECUTABLE_PATH || "/usr/bin/rpi-connect",
    connectPreflightPollSeconds: Number(process.env.CONNECT_PREFLIGHT_POLL_SECONDS || 2),
    connectPreflightTimeoutSeconds: Number(process.env.CONNECT_PREFLIGHT_TIMEOUT_SECONDS || 180),
    keyringPromptAutoCancel: (process.env.KEYRING_PROMPT_AUTO_CANCEL || "true").toLowerCase() !== "false",
    keyringPromptPollMs: Number(process.env.KEYRING_PROMPT_POLL_MS || 500),
    keyringPromptWatchSeconds: Number(process.env.KEYRING_PROMPT_WATCH_SECONDS || 45),
    projectStartupStaggerSeconds: Number(process.env.PROJECT_STARTUP_STAGGER_SECONDS || 60),
    supervisorWatchdogPollSeconds: Number(process.env.SUPERVISOR_WATCHDOG_POLL_SECONDS || 30),
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

export function projectIdFromChatUrl(raw) {
  const url = new URL(normalizeChatUrl(raw));
  const match = url.pathname.match(/^\/g\/(g-p-[^/]+)\/c\/[^/]+$/);
  return match?.[1] || "";
}

export function deriveProjectRootUrl(raw) {
  const id = projectIdFromChatUrl(raw);
  if (!id) return "";
  return `https://chatgpt.com/g/${id}/project`;
}

export function sameProjectChatUrl(projectRootUrl, chatUrl) {
  try {
    const root = new URL(normalizeChatUrl(projectRootUrl));
    const chat = new URL(normalizeChatUrl(chatUrl));
    if (root.origin !== chat.origin) return false;
    const rootMatch = root.pathname.match(/^\/g\/(g-p-[^/]+)(?:\/project)?$/);
    const chatMatch = chat.pathname.match(/^\/g\/(g-p-[^/]+)\/c\/[^/]+$/);
    return Boolean(rootMatch && chatMatch && rootMatch[1] === chatMatch[1]);
  } catch {
    return false;
  }
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

    const startupPriority = Number(project.startupPriority ?? 100);
    if (!Number.isInteger(startupPriority) || startupPriority < 0 || startupPriority > 1000) {
      throw new Error(`${project.id}: startupPriority must be an integer between 0 and 1000`);
    }

    const continueAfterSeconds = Number(project.continueAfterSeconds ?? 1480);
    if (!Number.isFinite(continueAfterSeconds) || continueAfterSeconds < 60) {
      throw new Error(`${project.id}: continueAfterSeconds must be >= 60`);
    }
    const autoContinueMode = String(project.autoContinueMode || "timer");
    if (!["timer", "on_completion"].includes(autoContinueMode)) {
      throw new Error(`${project.id}: autoContinueMode must be timer or on_completion`);
    }
    const completionSettleSeconds = Number(project.completionSettleSeconds ?? 10);
    if (!Number.isFinite(completionSettleSeconds) || completionSettleSeconds < 2 || completionSettleSeconds > 120) {
      throw new Error(`${project.id}: completionSettleSeconds must be between 2 and 120`);
    }
    const startupGraceSeconds = Number(project.startupGraceSeconds ?? 30);
    if (!Number.isFinite(startupGraceSeconds) || startupGraceSeconds < 5 || startupGraceSeconds > 120) {
      throw new Error(`${project.id}: startupGraceSeconds must be between 5 and 120`);
    }
    const watchdogSeconds = Number(project.watchdogSeconds ?? continueAfterSeconds);
    if (!Number.isFinite(watchdogSeconds) || watchdogSeconds < 60) {
      throw new Error(`${project.id}: watchdogSeconds must be >= 60`);
    }
    const noProgressAlertSeconds = Number(project.noProgressAlertSeconds ?? 1800);
    if (!Number.isFinite(noProgressAlertSeconds) || noProgressAlertSeconds < 60 || noProgressAlertSeconds > 86400) {
      throw new Error(`${project.id}: noProgressAlertSeconds must be between 60 and 86400`);
    }

    const continuationPrompt = String(project.continuationPrompt || "").trim();
    if (!continuationPrompt) throw new Error(`${project.id}: continuationPrompt is required`);

    const chatUrl = normalizeChatUrl(project.chatUrl);
    const autoRollover = project.autoRollover === true;
    const projectRootUrl = project.projectRootUrl
      ? normalizeChatUrl(project.projectRootUrl)
      : deriveProjectRootUrl(chatUrl);
    if (autoRollover && (!projectRootUrl || !sameProjectChatUrl(projectRootUrl, chatUrl))) {
      throw new Error(`${project.id}: autoRollover requires a ChatGPT Project chat URL`);
    }

    const rolloverPrompt = String(project.rolloverPrompt || (
      "Це автоматичне продовження попереднього чату цього ChatGPT Project, який досяг максимальної довжини. " +
      "Продовжуй роботу з останньої фактичної точки. Використай інструкції, файли та контекст цього Project. " +
      "Не повторюй уже виконане. Якщо для продовження реально потрібна дія користувача, зупинись і використай службовий стоп-маркер відповідно до інструкцій Autopilot."
    )).trim();

    return {
      id: String(project.id),
      name: String(project.name),
      enabled: project.enabled !== false,
      chatUrl,
      startupPriority,
      continueAfterSeconds,
      autoContinueMode,
      completionSettleSeconds,
      startupGraceSeconds,
      watchdogSeconds,
      noProgressAlertSeconds,
      userGateMarker: String(project.userGateMarker || "[[USER_ACTION_REQUIRED]]"),
      continuationPrompt,
      startImmediately: project.startImmediately === true,
      autoRollover,
      projectRootUrl,
      rolloverPrompt
    };
  });
}

export function publicProjects(projects) {
  return projects.filter((project) => project.enabled).map((project) => ({ ...project }));
}
