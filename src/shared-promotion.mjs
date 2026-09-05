export function validateSharedTargets(projects, targetIds) {
  const ids = [...new Set((targetIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new Error("shared_target_projects_required");
  const byId = new Map(projects.map((project) => [project.id, project]));
  return ids.map((id) => {
    const project = byId.get(id);
    if (!project || project.enabled !== true || project.backend !== "browser") {
      throw new Error(`${id}:enabled_browser_project_required`);
    }
    return project;
  });
}

export function validateSharedV2Projects(projects, targetIds) {
  return validateSharedTargets(projects, targetIds).map((project) => {
    const id = project.id;
    if (project.browserRecovery?.enabled !== true || project.browserRecovery?.allowSessionRestart !== false) {
      throw new Error(`${id}:unsafe_browser_recovery_policy`);
    }
    if (project.chatDiscovery?.enabled !== true || project.chatDiscovery?.autoAdopt !== false) {
      throw new Error(`${id}:unsafe_chat_discovery_policy`);
    }
    if (project.checkpointLedger?.enabled !== true) throw new Error(`${id}:checkpoint_ledger_required`);
    if (project.checkpointLedger?.evidence?.github?.requireMergedPr !== true || !project.checkpointLedger?.evidence?.github?.repository) {
      throw new Error(`${id}:merged_pr_evidence_required`);
    }
    return project;
  });
}
export function isFreshPausedIdleState(state, { now = Date.now(), maxAgeMs = 30000 } = {}) {
  const runtime = state?.runtime || {};
  const age = Number(now) - Number(runtime.lastSeenAt || 0);
  return state?.control?.paused === true
    && String(runtime.progressKey || "").includes("|idle|")
    && String(runtime.status || "") !== "working"
    && age >= 0 && age < maxAgeMs;
}

export function allFreshPausedIdle(states, targetIds, options = {}) {
  return targetIds.every((id) => isFreshPausedIdleState(states[id], options));
}

export function allFreshPausedIdleAfter(states, targetIds, minimumSeen, options = {}) {
  return targetIds.every((id) => {
    const floor = minimumSeen instanceof Map ? Number(minimumSeen.get(id) || 0) : Number(minimumSeen?.[id] || 0);
    return Number(states[id]?.runtime?.lastSeenAt || 0) > floor && isFreshPausedIdleState(states[id], options);
  });
}

export function acceptsSharedV2Status(payload, { targetIds, beforeSeen, now = Date.now(), maxAgeMs = 30000 } = {}) {
  const byId = new Map((payload?.projects || []).map((project) => [project.id, project]));
  return targetIds.every((id) => {
    const project = byId.get(id);
    if (!project) return false;
    const previous = beforeSeen instanceof Map ? Number(beforeSeen.get(id) || 0) : Number(beforeSeen?.[id] || 0);
    return Number(project.state?.runtime?.lastSeenAt || 0) > previous
      && isFreshPausedIdleState(project.state, { now, maxAgeMs })
      && project.browserRecovery?.enabled === true
      && project.browserRecovery?.allowSessionRestart === false
      && project.chatDiscovery?.enabled === true
      && project.chatDiscovery?.autoAdopt === false
      && project.checkpointLedger?.enabled === true
      && project.checkpointLedger?.evidenceConfigured === true;
  });
}
