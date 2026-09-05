export const OPERATOR_ACTIONS = new Set([
  "pause", "resume", "restart", "rollover", "scan_chats", "adopt_candidate"
]);

export function operatorProjectStatus(project, runtimeStore, progressWatchdog = null) {
  const state = runtimeStore?.snapshot(project.id) || null;
  return {
    id: project.id, name: project.name, chatUrl: project.chatUrl, planVersion: project.planVersion,
    chatDiscovery: project.chatDiscovery || { enabled: false, autoAdopt: false },
    browserRecovery: project.browserRecovery || { enabled: false, allowSessionRestart: false },
    checkpointLedger: {
      enabled: project.checkpointLedger?.enabled === true,
      evidenceCheckSeconds: Number(project.checkpointLedger?.evidenceCheckSeconds || 120),
      evidenceConfigured: Boolean(project.checkpointLedger?.evidence?.requireCleanWorktree
        || project.checkpointLedger?.evidence?.requireHeadAdvanceFrom
        || project.checkpointLedger?.evidence?.github?.requireMergedPr)
    },
    state, watchdog: progressWatchdog?.snapshot?.(project.id) || null
  };
}

export function applyOperatorAction(project, runtimeStore, action) {
  if (!OPERATOR_ACTIONS.has(action)) return { ok: false, status: 400, error: "unsupported_action" };
  if (!runtimeStore) return { ok: false, status: 503, error: "runtime_store_unavailable" };
  if (action === "pause") runtimeStore.setPaused(project.id, true);
  else if (action === "resume") runtimeStore.setPaused(project.id, false);
  else if (action === "restart") runtimeStore.bump(project.id, "restartGeneration");
  else if (action === "rollover") runtimeStore.bump(project.id, "rolloverGeneration");
  else if (action === "scan_chats") {
    if (!project.chatDiscovery?.enabled) return { ok: false, status: 409, error: "chat_discovery_disabled" };
    runtimeStore.bump(project.id, "discoveryScanGeneration");
  } else if (action === "adopt_candidate") {
    if (!project.chatDiscovery?.enabled) return { ok: false, status: 409, error: "chat_discovery_disabled" };
    if (!runtimeStore.snapshot(project.id).discovery?.candidateUrl) return { ok: false, status: 409, error: "no_discovery_candidate" };
    runtimeStore.bump(project.id, "adoptGeneration");
  }
  return { ok: true, status: 200, state: runtimeStore.snapshot(project.id) };
}

export function isOperatorProjectProvenIdle(status, now = Date.now()) {
  const runtime = status?.state?.runtime || {};
  const key = String(runtime.progressKey || "");
  const age = Number(now) - Number(runtime.lastSeenAt || 0);
  const online = status?.worker ? status.worker.online === true : true;
  return online && key.includes("|idle|") && age >= 0 && age < 30000 && String(runtime.status || "") !== "working";
}
