import fs from "node:fs";
import path from "node:path";
import { composeContinuationPrompt, planAnchorBlock } from "./prompt-compose.mjs";

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
    keyringPromptPollMs: Number(process.env.KEYRING_PROMPT_POLL_MS || 250),
    keyringPromptWatchSeconds: Number(process.env.KEYRING_PROMPT_WATCH_SECONDS ?? "0"),
    projectStartupStaggerSeconds: Number(process.env.PROJECT_STARTUP_STAGGER_SECONDS || 60),
    supervisorWatchdogPollSeconds: Number(process.env.SUPERVISOR_WATCHDOG_POLL_SECONDS || 30),
    browserProfileDir: resolveFromCwd(process.env.BROWSER_PROFILE_DIR || "./browser-profile"),
    logDir: resolveFromCwd(process.env.LOG_DIR || "./logs"),
    stateDir: resolveFromCwd(process.env.STATE_DIR || "./state"),
    projectsFile: resolveFromCwd(process.env.PROJECTS_FILE || "./config/projects.json"),
    extensionDir: resolveFromCwd("./extension"),
    bridgeHost: "127.0.0.1",
    bridgePort: 8765,
    controlHost: process.env.CONTROL_HOST || "127.0.0.1",
    controlPort: Number(process.env.CONTROL_PORT || 8766),
    miniappDir: resolveFromCwd(process.env.MINIAPP_DIR || "./web/miniapp"),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
    telegramOwnerUserId: process.env.TELEGRAM_OWNER_USER_ID || (Number(process.env.TELEGRAM_CHAT_ID) > 0 ? process.env.TELEGRAM_CHAT_ID : "")
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

function canonicalProjectId(segment) {
  const value = String(segment || "");
  const match = value.match(/^(g-p-[a-f0-9]{32})(?:-[^/]+)?$/i);
  return match?.[1] || value;
}

export function projectIdFromChatUrl(raw) {
  const url = new URL(normalizeChatUrl(raw));
  const match = url.pathname.match(/^\/g\/([^/]+)\/c\/[^/]+$/);
  return match ? canonicalProjectId(match[1]) : "";
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
    const rootMatch = root.pathname.match(/^\/g\/([^/]+)(?:\/project)?$/);
    const chatMatch = chat.pathname.match(/^\/g\/([^/]+)\/c\/[^/]+$/);
    return Boolean(
      rootMatch
      && chatMatch
      && canonicalProjectId(rootMatch[1]) === canonicalProjectId(chatMatch[1])
    );
  } catch {
    return false;
  }
}

function normalizeCodexConfig(project) {
  if (!project.repoPath || !path.isAbsolute(String(project.repoPath))) {
    throw new Error(`${project.id}: Codex backend requires an absolute repoPath`);
  }
  const raw = project.codex || {};
  const transport = raw.transport || {};
  const type = String(transport.type || "local");
  if (!["local", "ssh"].includes(type)) {
    throw new Error(`${project.id}: Codex transport must be local or ssh`);
  }
  const normalizedTransport = { type };
  if (type === "local") {
    normalizedTransport.executable = String(transport.executable || "codex");
  } else {
    for (const key of ["host", "user", "identityFile"]) {
      if (!String(transport[key] || "").trim()) {
        throw new Error(`${project.id}: Codex ssh transport requires ${key}`);
      }
    }
    normalizedTransport.host = String(transport.host);
    normalizedTransport.user = String(transport.user);
    normalizedTransport.identityFile = String(transport.identityFile);
    normalizedTransport.sshExecutable = String(transport.sshExecutable || "/usr/bin/ssh");
  }

  return {
    transport: normalizedTransport,
    networkAccess: raw.networkAccess === true,
    startOnBoot: raw.startOnBoot === true,
    autoContinue: raw.autoContinue !== false,
    approvalPolicy: "on-request",
    model: String(raw.model || "").trim(),
    effort: String(raw.effort || "").trim(),
    personality: String(raw.personality || "").trim()
  };
}

export function loadProjects(projectsFile) {
  const raw = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
  if (!Array.isArray(raw.projects)) throw new Error("config.projects must be an array");

  const ids = new Set();
  return raw.projects.map((project) => {
    if (!project.id || !project.name) {
      throw new Error("Each project requires id and name");
    }
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(project.id)) {
      throw new Error(`${project.id}: invalid project id`);
    }
    if (ids.has(project.id)) throw new Error(`Duplicate project id: ${project.id}`);
    ids.add(project.id);

    const backend = String(project.backend || "browser");
    if (!["browser", "codex"].includes(backend)) {
      throw new Error(`${project.id}: backend must be browser or codex`);
    }
    if (backend === "browser" && !project.chatUrl) {
      throw new Error(`${project.id}: browser backend requires chatUrl`);
    }

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
    const watchdogEnabled = project.watchdogEnabled !== false;
    const noProgressAlertSeconds = Number(project.noProgressAlertSeconds ?? 1800);
    if (!Number.isFinite(noProgressAlertSeconds) || noProgressAlertSeconds < 60 || noProgressAlertSeconds > 86400) {
      throw new Error(`${project.id}: noProgressAlertSeconds must be between 60 and 86400`);
    }

    const continuationPrompt = String(project.continuationPrompt || "").trim();
    if (!continuationPrompt) throw new Error(`${project.id}: continuationPrompt is required`);
    const planAnchor = String(project.planAnchor || "").trim();
    const planVersion = String(project.planVersion || "v1").trim().slice(0, 64) || "v1";
    const discoveryRaw = project.chatDiscovery || {};
    const chatDiscovery = {
      enabled: backend === "browser" && discoveryRaw.enabled === true,
      autoAdopt: backend === "browser" && discoveryRaw.autoAdopt === true,
      intervalSeconds: Number(discoveryRaw.intervalSeconds ?? 300),
      includeTitlePatterns: Array.isArray(discoveryRaw.includeTitlePatterns)
        ? discoveryRaw.includeTitlePatterns.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
        : []
    };
    if (!Number.isFinite(chatDiscovery.intervalSeconds) || chatDiscovery.intervalSeconds < 60 || chatDiscovery.intervalSeconds > 86400) {
      throw new Error(`${project.id}: chatDiscovery.intervalSeconds must be between 60 and 86400`);
    }
    if (chatDiscovery.autoAdopt && !chatDiscovery.enabled) {
      throw new Error(`${project.id}: chatDiscovery.autoAdopt requires chatDiscovery.enabled`);
    }

    const chatUrl = backend === "browser" ? normalizeChatUrl(project.chatUrl) : "";
    const autoRollover = backend === "browser" && project.autoRollover === true;
    const projectRootUrl = backend === "browser" && chatUrl
      ? (project.projectRootUrl ? normalizeChatUrl(project.projectRootUrl) : deriveProjectRootUrl(chatUrl))
      : "";
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
      backend,
      chatUrl,
      repoPath: backend === "codex" ? String(project.repoPath) : "",
      codex: backend === "codex" ? normalizeCodexConfig(project) : null,
      startupPriority,
      continueAfterSeconds,
      autoContinueMode,
      completionSettleSeconds,
      startupGraceSeconds,
      watchdogSeconds,
      watchdogEnabled,
      noProgressAlertSeconds,
      userGateMarker: String(project.userGateMarker || "[[USER_ACTION_REQUIRED]]"),
      continuationPrompt,
      planAnchor,
      planVersion,
      chatDiscovery,
      startImmediately: project.startImmediately === true,
      autoRollover,
      projectRootUrl,
      rolloverPrompt
    };
  });
}

export function publicProjects(projects, runtimeStore = null) {
  return projects
    .filter((project) => project.enabled && project.backend === "browser")
    .map((project) => {
      const snapshot = runtimeStore ? runtimeStore.snapshot(project.id) : null;
      return {
        ...project,
        codex: undefined,
        continuationPrompt: composeContinuationPrompt(project),
        rolloverPrompt: `${project.rolloverPrompt}${planAnchorBlock(project)}`.slice(0, 15000),
        control: snapshot?.control || { paused: false, restartGeneration: 0, rolloverGeneration: 0, adoptGeneration: 0, discoveryScanGeneration: 0 },
        runtimeCheckpoint: snapshot?.runtime || null,
        discovery: snapshot?.discovery || null
      };
    });
}
