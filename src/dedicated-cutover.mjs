function boundedText(value, max = 4096) {
  const text = String(value ?? "");
  if (!text || text.length > max || /[\r\n\0]/.test(text)) throw new Error("invalid_cutover_value");
  return text;
}

function quoteExec(value) {
  return `"${boundedText(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function isFreshPausedIdleState(state, { now = Date.now(), maxAgeMs = 30000 } = {}) {
  const runtime = state?.runtime || {};
  const age = Number(now) - Number(runtime.lastSeenAt || 0);
  return state?.control?.paused === true
    && String(runtime.progressKey || "").includes("|idle|")
    && String(runtime.status || "") !== "working"
    && age >= 0 && age < maxAgeMs;
}

export function validateDedicatedV2Project(project) {
  if (!project || project.id !== "autopilot-development" || project.enabled !== true || project.backend !== "browser") {
    throw new Error("invalid_autopilot_dev_project");
  }
  if (project.browserRecovery?.enabled !== true || project.browserRecovery?.allowSessionRestart !== false) {
    throw new Error("unsafe_browser_recovery_policy");
  }
  if (project.checkpointLedger?.enabled !== true) throw new Error("checkpoint_ledger_required");
  if (project.chatDiscovery?.enabled !== true || project.chatDiscovery?.autoAdopt !== false) {
    throw new Error("unsafe_chat_discovery_policy");
  }
  return project;
}

export function acceptsDedicatedV2Status(payload, { beforeSeen = 0, now = Date.now(), maxAgeMs = 30000 } = {}) {
  const project = (payload?.projects || []).find((item) => item?.id === "autopilot-development");
  if (!project) return false;
  return project.browserRecovery?.enabled === true
    && project.browserRecovery?.allowSessionRestart === false
    && project.checkpointLedger?.enabled === true
    && project.chatDiscovery?.enabled === true
    && project.chatDiscovery?.autoAdopt === false
    && Number(project.state?.runtime?.lastSeenAt || 0) > Number(beforeSeen || 0)
    && isFreshPausedIdleState(project.state, { now, maxAgeMs });
}

export function renderDedicatedWorkerUnits({ appDir, nodeBin, projectsFile, stateDir, homeDir, runtimeDir, chatUrl }) {
  for (const value of [appDir, nodeBin, projectsFile, stateDir, homeDir, runtimeDir, chatUrl]) boundedText(value);
  const bridge = `[Unit]\nDescription=ChatGPT Autopilot Dedicated Dev Bridge v2\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${appDir}\nEnvironment=HOME=${homeDir}\nEnvironment=PROJECTS_FILE=${projectsFile}\nEnvironment=STATE_DIR=${stateDir}\nEnvironment=WORKER_BRIDGE_PORT=8767\nExecStart=${quoteExec(nodeBin)} ${quoteExec(`${appDir}/src/browser-worker.mjs`)}\nRestart=always\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  const browser = `[Unit]\nDescription=ChatGPT Autopilot Dedicated Dev Browser v2\nAfter=chatgpt-autopilot-dev-bridge.service\nWants=chatgpt-autopilot-dev-bridge.service\n\n[Service]\nType=simple\nEnvironment=HOME=${homeDir}\nEnvironment=XDG_RUNTIME_DIR=${runtimeDir}\nEnvironment=WAYLAND_DISPLAY=wayland-0\nEnvironment=DISPLAY=:0\nEnvironment=DBUS_SESSION_BUS_ADDRESS=unix:path=${runtimeDir}/bus\nExecStart=/usr/bin/chromium --force-renderer-accessibility --enable-gpu-rasterization --disable-dev-shm-usage --ozone-platform=wayland --use-angle=gles --user-data-dir=${appDir}/browser-profile-autopilot-dev --load-extension=${appDir}/extension --disable-extensions-except=${appDir}/extension --no-first-run --disable-session-crashed-bubble --new-window ${quoteExec(chatUrl)}\nRestart=always\nRestartSec=8\n\n[Install]\nWantedBy=default.target\n`;
  return { bridge, browser };
}
