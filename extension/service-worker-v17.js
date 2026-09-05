importScripts("bridge-policy.js", "lease-policy.js", "discovery-policy.js", "mirror-sync-policy.js", "recovery-policy.js", "rollover-policy.js");
const BRIDGE_CANDIDATES = ["http://127.0.0.1:8765", "http://127.0.0.1:8767"];
let bridgeBaseCache = "";
const PULSE_ALARM = "autopilot-pulse";
const MONITOR_STARTED_KEY = "monitor:startedAt";
const MISSING_PREFIX = "missing:";
const ROLLOVER_PREFIX = "rollover:";
const DISCOVERY_PREFIX = "discovery:";
const DISCOVERY_LAST_PREFIX = "discovery-last:";
const MIRROR_PREFIX = "mirror-probe:";
const MIRROR_LAST_PREFIX = "mirror-last:";
const STARTUP_GRACE_MS = 90000;
const ROLLOVER_TIMEOUT_MS = 120000;
const DISCOVERY_TIMEOUT_MS = 90000;
const MIRROR_TIMEOUT_MS = 300000;
const MIRROR_SETTLE_MS = 30000;
const RECOVERY_GRACE_MS = 45000;
const RECOVERY_WAIT_GENERATION_MS = 15000;
const RECOVERY_COOLDOWN_MS = 300000;
const LEASE_TTL_MS = 90000;
const claimChains = new Map();

async function fetchBridgeJson(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  if (!response.ok) throw new Error(`bridge_http_${response.status}`);
  return response.json();
}

async function resolveBridge({ force = false } = {}) {
  if (bridgeBaseCache && !force) return bridgeBaseCache;
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const tabUrls = tabs.map((tab) => tab.url || "").filter(Boolean);
  const candidates = [];
  for (const base of BRIDGE_CANDIDATES) {
    try {
      const config = await fetchBridgeJson(base, "/config");
      candidates.push({ base, config });
    } catch {}
  }
  const selected = AutopilotBridgePolicy.selectBridge(candidates, tabUrls);
  if (!selected?.base) throw new Error("bridge_unresolved");
  bridgeBaseCache = selected.base;
  return bridgeBaseCache;
}

async function bridge(path, options = {}) {
  let base = await resolveBridge();
  try {
    return await fetchBridgeJson(base, path, options);
  } catch (error) {
    bridgeBaseCache = "";
    base = await resolveBridge({ force: true });
    return fetchBridgeJson(base, path, options);
  }
}

function normalizeChatUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return "";
  }
}

function canonicalProjectId(segment) {
  const value = String(segment || "");
  const match = value.match(/^(g-p-[a-f0-9]{32})(?:-[^/]+)?$/i);
  return match?.[1] || value;
}

function projectIdFromRoot(raw) {
  try {
    const url = new URL(normalizeChatUrl(raw));
    const match = url.pathname.match(/^\/g\/([^/]+)(?:\/project)?$/);
    return match ? canonicalProjectId(match[1]) : "";
  } catch {
    return "";
  }
}

function projectIdFromChat(raw) {
  try {
    const url = new URL(normalizeChatUrl(raw));
    const match = url.pathname.match(/^\/g\/([^/]+)\/c\/[^/]+$/);
    return match ? canonicalProjectId(match[1]) : "";
  } catch {
    return "";
  }
}

function sameProjectChat(projectRootUrl, chatUrl) {
  const root = projectIdFromRoot(projectRootUrl);
  const chat = projectIdFromChat(chatUrl);
  return Boolean(root && chat && root === chat);
}

async function ensurePulse() {
  const alarm = await chrome.alarms.get(PULSE_ALARM);
  if (!alarm) chrome.alarms.create(PULSE_ALARM, { periodInMinutes: 0.5 });
  const current = (await chrome.storage.session.get(MONITOR_STARTED_KEY))[MONITOR_STARTED_KEY];
  if (!current) await chrome.storage.session.set({ [MONITOR_STARTED_KEY]: Date.now() });
}

async function getProjects() {
  const config = await bridge("/config");
  return Array.isArray(config.projects) ? config.projects : [];
}

async function claimUnlocked(projectId, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || !projectId) return { granted: false };
  const mirrorKey = `${MIRROR_PREFIX}${projectId}`;
  const mirrorEntry = (await chrome.storage.session.get(mirrorKey))[mirrorKey] || null;
  if (AutopilotMirrorSyncPolicy.isProbeTab(mirrorEntry || {}, tabId)) {
    return { granted: false, reason: "mirror_probe" };
  }
  const key = `lease:${projectId}`;
  const current = (await chrome.storage.session.get(key))[key];
  if (current?.tabId !== undefined && current.tabId !== tabId) {
    const stale = AutopilotLeasePolicy.isLeaseStale({
      leaseAtMs: current.at,
      nowMs: Date.now(),
      ttlMs: LEASE_TTL_MS
    });
    if (!stale) {
      try {
        await chrome.tabs.get(current.tabId);
        return { granted: false, tabId: current.tabId };
      } catch {
        await chrome.storage.session.remove(key);
      }
    } else {
      await chrome.storage.session.remove(key);
    }
  }
  await chrome.storage.session.set({ [key]: { tabId, at: Date.now() } });
  return { granted: true, tabId };
}

async function claim(projectId, sender) {
  const prior = claimChains.get(projectId) || Promise.resolve();
  const next = prior.catch(() => {}).then(() => claimUnlocked(projectId, sender));
  claimChains.set(projectId, next);
  try {
    return await next;
  } finally {
    if (claimChains.get(projectId) === next) claimChains.delete(projectId);
  }
}

async function releaseLeasesForTab(tabId) {
  const all = await chrome.storage.session.get(null);
  const remove = Object.entries(all)
    .filter(([key, value]) => key.startsWith("lease:") && value?.tabId === tabId)
    .map(([key]) => key);
  if (remove.length) await chrome.storage.session.remove(remove);
}

async function notifyBridge(projectId, event) {
  return bridge("/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, event })
  });
}

async function heartbeatBridge(projectId, progressKey, status, detail = {}) {
  return bridge("/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, progressKey, status, ...detail })
  });
}

async function tabRuntimeStatus(tabId) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: "GET_RUNTIME_STATUS" });
    return result?.ok ? result : null;
  } catch { return null; }
}

async function configuredProjectTab(project) {
  const target = normalizeChatUrl(project.chatUrl || "");
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  return tabs.find((tab) => normalizeChatUrl(tab.url || "") === target) || null;
}

async function mirrorEntries() {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(MIRROR_PREFIX))
    .map(([key, value]) => ({ key, projectId: key.slice(MIRROR_PREFIX.length), ...value }));
}

async function closeMirrorEntry(entry) {
  await chrome.storage.session.remove(entry.key);
  try { await chrome.tabs.remove(entry.tabId); } catch {}
}

async function cleanupMirrorEntriesForTab(tabId) {
  for (const entry of await mirrorEntries()) {
    if (Number(entry.sourceTabId) === tabId) await closeMirrorEntry(entry);
    else if (Number(entry.tabId) === tabId) await chrome.storage.session.remove(entry.key);
  }
}

async function maybeStartMirrorProbe() {
  const pending = await mirrorEntries();
  const pendingProjects = new Set(pending.map((entry) => entry.projectId));
  const projects = await getProjects();
  const now = Date.now();
  for (const project of projects) {
    const enabled = project.browserRecovery?.enabled === true;
    const sourceTab = await configuredProjectTab(project);
    if (!Number.isInteger(sourceTab?.id)) continue;
    const heartbeatAt = Number(project.runtimeCheckpoint?.lastSeenAt || 0);
    const staleMs = Number(project.browserRecovery?.staleHeartbeatSeconds || 90) * 1000;
    const sourceFresh = Boolean(heartbeatAt && now - heartbeatAt < staleMs);
    const status = await tabRuntimeStatus(sourceTab.id);
    if (!status) continue;
    const lastKey = `${MIRROR_LAST_PREFIX}${project.id}`;
    const last = (await chrome.storage.session.get(lastKey))[lastKey] || {};
    const intervalMs = Number(project.browserRecovery?.mirrorSyncSeconds || 120) * 1000;
    const due = now - Number(last.lastProbeAt || 0) >= intervalMs;
    if (!AutopilotMirrorSyncPolicy.shouldStartProbe({
      enabled, pending: pendingProjects.has(project.id), sourcePresent: true, sourceFresh,
      sourceKnown: Boolean(status.generatingKnown),
      sourceGenerating: Boolean(status.generating),
      sourceBlocked: Boolean(status.authBlocked || status.rateLimited || status.safetyBlocked),
      sourceTurnId: String(project.runtimeCheckpoint?.lastTurnId || ""),
      due
    })) continue;
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    if (!Number.isInteger(tab.id)) continue;
    const key = `${MIRROR_PREFIX}${project.id}`;
    const sourceTurnId = String(project.runtimeCheckpoint?.lastTurnId || "");
    const entry = { tabId: tab.id, sourceTabId: sourceTab.id, startedAt: now, sourceTurnId, observedKey: "", observedAt: 0 };
    await chrome.storage.session.set({
      [key]: entry,
      [lastKey]: { ...last, lastProbeAt: now }
    });
    await mirrorReport(project.id, {
      result: "started", lastProbeAt: now, sourceTurnId, remoteTurnId: "", lastObservedAt: 0, lastError: ""
    }).catch(() => {});
    try { await chrome.tabs.update(tab.id, { url: project.chatUrl }); }
    catch {
      await mirrorReport(project.id, { result: "error", lastProbeAt: now, sourceTurnId, remoteTurnId: "", lastError: "probe_navigation_failed" }).catch(() => {});
      await closeMirrorEntry({ key, tabId: tab.id });
    }
    return;
  }
}

async function mirrorReport(projectId, patch = {}) {
  return bridge("/mirror-report", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, ...patch })
  });
}

async function recoveryReport(projectId, patch) {
  return bridge("/recovery-report", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, ...patch })
  });
}

async function recoveryClear(projectId) {
  return bridge("/recovery-clear", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId })
  });
}

async function recoveryFailed(projectId, reason, lastError = "") {
  return bridge("/recovery-failed", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, reason, lastError, cooldownUntil: Date.now() + RECOVERY_COOLDOWN_MS })
  });
}

function recoveryCanMutate(status) {
  return AutopilotRecoveryPolicy.mayMutateTab({
    generatingKnown: Boolean(status?.generatingKnown), generating: Boolean(status?.generating),
    authBlocked: Boolean(status?.authBlocked), rateLimited: Boolean(status?.rateLimited),
    safetyBlocked: Boolean(status?.safetyBlocked)
  });
}

function recoveryBlocked(status) {
  return Boolean(status?.authBlocked || status?.rateLimited || status?.safetyBlocked);
}

async function openConfiguredTab(project) {
  return chrome.tabs.create({ url: project.chatUrl, active: false });
}

async function startRecovery(project, { tab = null, reason = "unknown", status = null } = {}) {
  const current = project.recovery || {};
  const now = Date.now();
  if (Number(current.cooldownUntil || 0) > now) return { ok: true, suppressed: true, cooldown: true };
  if (status?.composerPresent) {
    if (current.stage && current.stage !== "idle") await recoveryClear(project.id);
    return { ok: true, healthy: true };
  }
  if (current.stage && !["idle", "failed"].includes(String(current.stage))) {
    return { ok: true, suppressed: true, activeStage: current.stage };
  }
  if (recoveryBlocked(status)) return recoveryFailed(project.id, reason, "auth_rate_or_safety_gate");
  if (status?.generating) {
    await recoveryReport(project.id, {
      stage: "blocked", reason, attempts: Number(current.attempts || 0),
      nextCheckAt: now + RECOVERY_WAIT_GENERATION_MS, lastAttemptAt: now, lastError: "generation_active"
    });
    return { ok: true, waitingForGeneration: true };
  }
  const canMutate = tab ? recoveryCanMutate(status) : true;
  const stage = AutopilotRecoveryPolicy.nextStage({ stage: "idle", tabPresent: Boolean(tab), canMutate });
  if (stage === "blocked") return recoveryFailed(project.id, reason, "generation_state_unknown");
  if (stage === "soft_reload") {
    await recoveryReport(project.id, {
      stage, reason, attempts: Number(current.attempts || 0) + 1,
      softReloads: Number(current.softReloads || 0) + 1, lastAttemptAt: now, nextCheckAt: now + RECOVERY_GRACE_MS,
      alerted: false, lastError: ""
    });
    await chrome.tabs.reload(tab.id);
    return { ok: true, stage };
  }
  const created = await openConfiguredTab(project);
  await recoveryReport(project.id, {
    stage: "tab_recreate", reason, attempts: Number(current.attempts || 0) + 1,
    tabRecreates: Number(current.tabRecreates || 0) + 1, lastAttemptAt: now, nextCheckAt: now + RECOVERY_GRACE_MS,
    alerted: false, lastError: ""
  });
  return { ok: true, stage: "tab_recreate", tabId: created.id };
}

async function discoveryEntries() {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(DISCOVERY_PREFIX) && !key.startsWith(DISCOVERY_LAST_PREFIX))
    .map(([key, value]) => ({ key, projectId: key.slice(DISCOVERY_PREFIX.length), ...value }));
}

async function closeDiscoveryEntry(entry) {
  await chrome.storage.session.remove(entry.key);
  try { await chrome.tabs.remove(entry.tabId); } catch {}
}

async function performAdoption(project, sourceTabId, candidate, mode) {
  if (!candidate?.url) return { ok: false, error: "no_candidate" };
  const status = await tabRuntimeStatus(sourceTabId);
  if (!status || !AutopilotDiscoveryPolicy.shouldAdopt({
    mode, generating: Boolean(status.generating), paused: Boolean(project.control?.paused), candidate: candidate.url
  })) return { ok: false, error: "adoption_blocked" };
  const result = await bridge("/adopt-chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id, mode, chatUrl: candidate.url,
      title: candidate.title || "", preview: candidate.preview || ""
    })
  });
  await setProjectState(project.id, {
    lastAdoptGeneration: Number(project.control?.adoptGeneration || 0),
    lastStatus: "chat_adopted", failures: 0, rolloverInProgress: false
  });
  await releaseLeasesForTab(sourceTabId);
  await chrome.tabs.update(sourceTabId, { url: result.chatUrl });
  return result;
}

async function maybeStartDiscoveryScans() {
  const projects = await getProjects();
  const pending = new Set((await discoveryEntries()).map((entry) => entry.projectId));
  const now = Date.now();
  for (const project of projects) {
    if (!project.chatDiscovery?.enabled || !project.projectRootUrl || pending.has(project.id)) continue;
    const lastKey = `${DISCOVERY_LAST_PREFIX}${project.id}`;
    const last = (await chrome.storage.session.get(lastKey))[lastKey] || {};
    const scanGeneration = Number(project.control?.discoveryScanGeneration || 0);
    const forced = scanGeneration > Number(last.scanGeneration || 0);
    const due = now - Number(last.lastScanAt || 0) >= Number(project.chatDiscovery.intervalSeconds || 300) * 1000;
    const sourceTab = await configuredProjectTab(project);
    if (!Number.isInteger(sourceTab?.id)) continue;
    const status = await tabRuntimeStatus(sourceTab.id);
    if (!status || !AutopilotDiscoveryPolicy.shouldStartScan({
      enabled: true, pending: false, generating: Boolean(status.generating), paused: Boolean(project.control?.paused), forced, due
    })) continue;
    const tab = await chrome.tabs.create({ url: project.projectRootUrl, active: false });
    if (!Number.isInteger(tab.id)) continue;
    const key = `${DISCOVERY_PREFIX}${project.id}`;
    await chrome.storage.session.set({
      [key]: { tabId: tab.id, sourceTabId: sourceTab.id, startedAt: now },
      [lastKey]: { lastScanAt: now, scanGeneration }
    });
  }
}

async function processPendingDiscoveries() {
  const entries = await discoveryEntries();
  if (!entries.length) return;
  const projects = await getProjects();
  const byId = new Map(projects.map((project) => [project.id, project]));
  for (const entry of entries) {
    const project = byId.get(entry.projectId);
    if (!project?.chatDiscovery?.enabled) {
      await closeDiscoveryEntry(entry);
      continue;
    }
    const elapsedMs = Date.now() - Number(entry.startedAt || 0);
    if (AutopilotDiscoveryPolicy.scanDisposition({ timedOut: elapsedMs > DISCOVERY_TIMEOUT_MS }) === "timeout") {
      await bridge("/discovery-candidates", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, candidates: [] })
      }).catch(() => {});
      await closeDiscoveryEntry(entry);
      continue;
    }
    let tab;
    try { tab = await chrome.tabs.get(entry.tabId); } catch { await closeDiscoveryEntry(entry); continue; }
    if (tab.status !== "complete" || projectIdFromRoot(tab.url || "") !== projectIdFromRoot(project.projectRootUrl)) continue;
    let scan;
    try {
      scan = await chrome.tabs.sendMessage(entry.tabId, { type: "DISCOVERY_SCAN", projectRootUrl: project.projectRootUrl });
    } catch { continue; }
    if (!scan?.ok || !Array.isArray(scan.candidates)) continue;
    const currentChatUrl = normalizeChatUrl(project.chatUrl || "");
    const candidateUrls = scan.candidates.map((candidate) => normalizeChatUrl(candidate?.url || ""));
    const disposition = AutopilotDiscoveryPolicy.scanDisposition({ currentChatUrl, candidateUrls });
    if (disposition !== "finalize") continue;
    const result = await bridge("/discovery-candidates", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, candidates: scan.candidates })
    });
    if (result.shouldAdopt && result.candidate) {
      await performAdoption(project, entry.sourceTabId, result.candidate, "auto").catch(() => {});
    }
    await closeDiscoveryEntry(entry);
  }
}

async function adoptCandidate(message, sender) {
  const tabId = sender.tab?.id;
  const projectId = String(message.projectId || "");
  if (!Number.isInteger(tabId) || !projectId) return { ok: false, error: "invalid_sender" };
  const projects = await getProjects();
  const project = projects.find((item) => item.id === projectId);
  if (!project?.chatDiscovery?.enabled) return { ok: false, error: "chat_discovery_disabled" };
  const sourceUrl = normalizeChatUrl(sender.tab?.url || "");
  if (!sameProjectChat(project.projectRootUrl, sourceUrl) || sourceUrl !== normalizeChatUrl(project.chatUrl)) {
    return { ok: false, error: "source_not_configured_chat" };
  }
  const candidate = AutopilotDiscoveryPolicy.durableCandidate(project.discovery || {});
  return performAdoption(project, tabId, candidate, "manual");
}

async function rolloverEntries() {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(ROLLOVER_PREFIX))
    .map(([key, value]) => ({ key, projectId: key.slice(ROLLOVER_PREFIX.length), ...value }));
}

async function setProjectState(projectId, patch) {
  const key = `project:${projectId}`;
  const current = (await chrome.storage.local.get(key))[key] || {};
  await chrome.storage.local.set({ [key]: { ...current, ...patch, updatedAt: Date.now() } });
}

async function failRollover(entry) {
  await setProjectState(entry.projectId, {
    rolloverInProgress: false,
    pausedForUser: true,
    failures: 0,
    watchdogAt: 0,
    watchdogNotified: false,
    lastStatus: "rollover_failed"
  });
  await chrome.storage.session.remove(entry.key);
  await notifyBridge(entry.projectId, "AUTOMATION_ERROR").catch(() => {});
}

async function completeRollover(entry, project, chatUrl) {
  const result = await bridge("/rollover-complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: entry.projectId, chatUrl })
  });
  await setProjectState(entry.projectId, {
    rolloverInProgress: false,
    pausedForUser: false,
    nextAt: Date.now() + Number(project.continueAfterSeconds || 60) * 1000,
    failures: 0,
    watchdogAt: 0,
    watchdogNotified: false,
    lastProgressKey: "",
    lastProgressAt: 0,
    completionObservedTurnKey: null,
    completionObservedAt: 0,
    lastStatus: "rolled_over"
  });
  await chrome.storage.session.remove(entry.key);
  await releaseLeasesForTab(entry.tabId);
  return result;
}

async function processPendingRollovers() {
  const entries = await rolloverEntries();
  if (!entries.length) return;
  const projects = await getProjects();
  const byId = new Map(projects.map((project) => [project.id, project]));

  for (const entry of entries) {
    const project = byId.get(entry.projectId);
    if (!project?.autoRollover || !project.projectRootUrl) {
      await failRollover(entry);
      continue;
    }
    if (Date.now() - Number(entry.startedAt || 0) > ROLLOVER_TIMEOUT_MS) {
      await failRollover(entry);
      continue;
    }

    let tab;
    try { tab = await chrome.tabs.get(entry.tabId); }
    catch { await failRollover(entry); continue; }
    const current = normalizeChatUrl(tab.url || "");

    if (sameProjectChat(project.projectRootUrl, current) && current !== normalizeChatUrl(entry.sourceUrl)) {
      try { await completeRollover(entry, project, current); }
      catch { /* retry until timeout */ }
      continue;
    }

    if (current === normalizeChatUrl(entry.projectRootUrl) && !entry.promptSentAt) {
      try {
        const response = await chrome.tabs.sendMessage(entry.tabId, {
          type: "ROLLOVER_SEND",
          prompt: entry.prompt
        });
        if (response?.ok) {
          await chrome.storage.session.set({
            [entry.key]: { ...entry, promptSentAt: Date.now() }
          });
        }
      } catch {
        // Content script may not be ready yet; next pulse retries.
      }
    }
  }
}

async function startRollover(message, sender) {
  const tabId = sender.tab?.id;
  const projectId = String(message.projectId || "");
  if (!Number.isInteger(tabId) || !projectId) return { ok: false, error: "invalid_sender" };
  const projects = await getProjects();
  const project = projects.find((item) => item.id === projectId);
  if (!project?.autoRollover || !project.projectRootUrl) {
    return { ok: false, error: "rollover_disabled" };
  }
  const sourceUrl = normalizeChatUrl(sender.tab?.url || project.chatUrl || "");
  if (!sameProjectChat(project.projectRootUrl, sourceUrl)) {
    return { ok: false, error: "source_outside_project" };
  }

  const handoff = String(message.handoff || "").slice(-12000);
  const prompt = AutopilotRolloverPolicy.composeHandoff({ preamble: project.rolloverPrompt, handoff });
  const key = `${ROLLOVER_PREFIX}${projectId}`;
  await chrome.storage.session.set({
    [key]: {
      tabId,
      sourceUrl,
      projectRootUrl: project.projectRootUrl,
      prompt,
      startedAt: Date.now(),
      promptSentAt: 0
    }
  });
  await setProjectState(projectId, { rolloverInProgress: true, lastStatus: "rollover_in_progress" });
  await releaseLeasesForTab(tabId);
  await chrome.tabs.update(tabId, { url: project.projectRootUrl });
  return { ok: true };
}

async function sessionHealthSummary(projects) {
  let enabledCount = 0;
  let unhealthyCount = 0;
  let activeGenerationCount = 0;
  let unknownGenerationCount = 0;
  for (const project of projects.filter((item) => item.enabled !== false && item.backend === "browser")) {
    enabledCount += 1;
    const tab = await configuredProjectTab(project);
    if (!tab) { unhealthyCount += 1; continue; }
    const status = await tabRuntimeStatus(tab.id);
    if (!status?.generatingKnown) unknownGenerationCount += 1;
    if (status?.generating) activeGenerationCount += 1;
    if (!status?.composerPresent) unhealthyCount += 1;
  }
  return { enabledCount, unhealthyCount, activeGenerationCount, unknownGenerationCount };
}

async function recreateProjectTab(project, oldTab = null, recovery = {}) {
  const created = await openConfiguredTab(project);
  await recoveryReport(project.id, {
    stage: "tab_recreate", reason: recovery.reason || "tab_unhealthy",
    attempts: Number(recovery.attempts || 0) + 1, tabRecreates: Number(recovery.tabRecreates || 0) + 1,
    softReloads: Number(recovery.softReloads || 0), browserRestarts: Number(recovery.browserRestarts || 0),
    lastAttemptAt: Date.now(), nextCheckAt: Date.now() + RECOVERY_GRACE_MS, alerted: false, lastError: ""
  });
  if (Number.isInteger(oldTab?.id)) {
    try { await chrome.tabs.remove(oldTab.id); } catch {}
  }
  return created;
}

async function processRecoveries() {
  const projects = await getProjects();
  const now = Date.now();
  for (const project of projects) {
    const recovery = project.recovery || {};
    const stage = String(recovery.stage || "idle");
    if (stage === "idle") continue;
    const tab = await configuredProjectTab(project);
    const status = tab ? await tabRuntimeStatus(tab.id) : null;
    if (status?.composerPresent) {
      const wasAlerted = Boolean(recovery.alerted);
      await recoveryClear(project.id);
      if (wasAlerted) await notifyBridge(project.id, "RECOVERED").catch(() => {});
      continue;
    }
    if (stage === "failed") {
      if (Number(recovery.cooldownUntil || 0) <= now) {
        await startRecovery(project, { tab, reason: recovery.reason || "retry_after_cooldown", status });
      }
      continue;
    }
    if (Number(recovery.nextCheckAt || 0) > now) continue;
    if (status?.generating) {
      await recoveryReport(project.id, { ...recovery, stage: "blocked", nextCheckAt: now + RECOVERY_WAIT_GENERATION_MS, lastError: "generation_active" });
      continue;
    }
    if (recoveryBlocked(status)) {
      await recoveryFailed(project.id, recovery.reason || "session_blocked", "auth_rate_or_safety_gate");
      continue;
    }
    if (stage === "blocked") {
      if (tab && status && recoveryCanMutate(status)) {
        await recoveryReport(project.id, { ...recovery, stage: "soft_reload", attempts: Number(recovery.attempts || 0) + 1, softReloads: Number(recovery.softReloads || 0) + 1, lastAttemptAt: now, nextCheckAt: now + RECOVERY_GRACE_MS, lastError: "" });
        await chrome.tabs.reload(tab.id);
      } else if (!tab) {
        await recreateProjectTab(project, null, recovery);
      } else {
        await recoveryFailed(project.id, recovery.reason || "status_unknown", "generation_state_unknown");
      }
      continue;
    }
    if (stage === "soft_reload") {
      if (!tab) { await recreateProjectTab(project, null, recovery); continue; }
      if (!status || !recoveryCanMutate(status)) {
        await recoveryFailed(project.id, recovery.reason || "soft_reload_failed", "unsafe_after_soft_reload");
        continue;
      }
      await recreateProjectTab(project, tab, recovery);
      continue;
    }
    if (stage === "tab_recreate") {
      const health = await sessionHealthSummary(projects);
      const restart = project.browserRecovery?.allowSessionRestart !== false
        && AutopilotRecoveryPolicy.shouldRestartBrowser(health)
        && Number(recovery.browserRestarts || 0) < 1;
      if (!restart) {
        await recoveryFailed(project.id, recovery.reason || "tab_recreate_failed", "bounded_recovery_exhausted");
        continue;
      }
      await recoveryReport(project.id, { ...recovery, stage: "browser_restart", attempts: Number(recovery.attempts || 0) + 1, browserRestarts: Number(recovery.browserRestarts || 0) + 1, lastAttemptAt: now, nextCheckAt: now + STARTUP_GRACE_MS, lastError: "" });
      await bridge("/browser-restart-request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, reason: recovery.reason || "session_unhealthy" }) });
      return;
    }
    if (stage === "browser_restart") {
      await recoveryFailed(project.id, recovery.reason || "browser_restart_failed", "browser_restart_did_not_recover");
    }
  }
}

async function processPendingMirrorProbes() {
  const entries = await mirrorEntries();
  if (!entries.length) return;
  const projects = await getProjects();
  const byId = new Map(projects.map((project) => [project.id, project]));
  const now = Date.now();
  for (const entry of entries) {
    const project = byId.get(entry.projectId);
    if (!project?.browserRecovery?.enabled || now - Number(entry.startedAt || 0) > MIRROR_TIMEOUT_MS) {
      if (project) {
        const lastKey = `${MIRROR_LAST_PREFIX}${project.id}`;
        const last = (await chrome.storage.session.get(lastKey))[lastKey] || {};
        await chrome.storage.session.set({ [lastKey]: { ...last, lastProbeAt: now, lastTimeoutAt: now } });
        await mirrorReport(project.id, {
          result: "timeout", lastProbeAt: Number(entry.startedAt || 0), sourceTurnId: String(entry.sourceTurnId || ""),
          remoteTurnId: "", lastObservedAt: now, lastError: "probe_timeout"
        }).catch(() => {});
      }
      await closeMirrorEntry(entry);
      continue;
    }
    let sourceTab;
    let probeTab;
    try { sourceTab = await chrome.tabs.get(entry.sourceTabId); } catch { await closeMirrorEntry(entry); continue; }
    try { probeTab = await chrome.tabs.get(entry.tabId); } catch { await chrome.storage.session.remove(entry.key); continue; }
    if (normalizeChatUrl(sourceTab.url || "") !== normalizeChatUrl(project.chatUrl)) {
      await closeMirrorEntry(entry);
      continue;
    }
    if (probeTab.status !== "complete" || normalizeChatUrl(probeTab.url || "") !== normalizeChatUrl(project.chatUrl)) continue;
    let snapshot;
    try { snapshot = await chrome.tabs.sendMessage(entry.tabId, { type: "MIRROR_SNAPSHOT" }); }
    catch { continue; }
    if (!snapshot?.ok || snapshot.projectId !== project.id) continue;
    const disposition = AutopilotMirrorSyncPolicy.probeDisposition({
      sourceTurnId: String(project.runtimeCheckpoint?.lastTurnId || ""), snapshot,
      observedKey: String(entry.observedKey || ""), observedAt: Number(entry.observedAt || 0),
      now, settleMs: MIRROR_SETTLE_MS
    });
    if (["wait", "settle"].includes(disposition.action)) {
      await chrome.storage.session.set({ [entry.key]: {
        ...entry, observedKey: disposition.key, observedAt: disposition.observedAt
      } });
      continue;
    }
    if (["same", "blocked"].includes(disposition.action)) {
      await mirrorReport(project.id, {
        result: disposition.action, lastProbeAt: Number(entry.startedAt || 0), sourceTurnId: String(entry.sourceTurnId || ""),
        remoteTurnId: String(snapshot.turnId || ""), lastObservedAt: now,
        lastError: disposition.action === "blocked" ? "remote_auth_rate_or_safety_gate" : ""
      }).catch(() => {});
      await closeMirrorEntry(entry);
      continue;
    }
    if (disposition.action === "refresh") {
      const lastKey = `${MIRROR_LAST_PREFIX}${project.id}`;
      const last = (await chrome.storage.session.get(lastKey))[lastKey] || {};
      let sourceSnapshot;
      try { sourceSnapshot = await chrome.tabs.sendMessage(sourceTab.id, { type: "MIRROR_SNAPSHOT" }); } catch { sourceSnapshot = null; }
      const sourceStillSafe = Boolean(
        sourceSnapshot?.ok && sourceSnapshot.projectId === project.id && sourceSnapshot.generatingKnown
        && !sourceSnapshot.generating && !sourceSnapshot.authBlocked && !sourceSnapshot.rateLimited && !sourceSnapshot.safetyBlocked
        && String(sourceSnapshot.turnId || "") === String(entry.sourceTurnId || "")
      );
      if (!sourceStillSafe) {
        await mirrorReport(project.id, {
          result: "blocked", lastProbeAt: Number(entry.startedAt || 0), sourceTurnId: String(entry.sourceTurnId || ""),
          remoteTurnId: String(snapshot.turnId || ""), lastObservedAt: now, lastError: "source_changed_or_unsafe_before_refresh"
        }).catch(() => {});
        await closeMirrorEntry(entry);
        continue;
      }
      await mirrorReport(project.id, {
        result: "refresh", lastProbeAt: Number(entry.startedAt || 0), sourceTurnId: String(entry.sourceTurnId || ""),
        remoteTurnId: String(snapshot.turnId || ""), lastObservedAt: now, lastRefreshAt: now, lastError: ""
      }).catch(() => {});
      await closeMirrorEntry(entry);
      await chrome.storage.session.set({ [lastKey]: { ...last, lastRefreshAt: now } });
      try { await chrome.tabs.reload(sourceTab.id); } catch {}
    }
  }
}

async function monitorConfiguredTabs() {
  const startedAt = Number((await chrome.storage.session.get(MONITOR_STARTED_KEY))[MONITOR_STARTED_KEY] || 0);
  if (!startedAt || Date.now() - startedAt < STARTUP_GRACE_MS) return;

  const projects = await getProjects();
  const pending = new Set((await rolloverEntries()).map((entry) => entry.projectId));
  const tabs = await chrome.tabs.query({});
  const now = Date.now();

  for (const project of projects) {
    if (pending.has(project.id)) continue;
    const tab = tabs.find((item) => normalizeChatUrl(item.url || "") === normalizeChatUrl(project.chatUrl));
    const recoveryEnabled = project.browserRecovery?.enabled === true;
    const authGate = tabs.some((item) => /chatgpt\.com\/(?:auth|login)(?:\/|\?|$)/i.test(String(item.url || "")));
    const challengeGate = tabs.some((item) => /challenges\.cloudflare\.com/i.test(String(item.url || "")));
    const heartbeatAt = Number(project.runtimeCheckpoint?.lastSeenAt || 0);
    const staleMs = Number(project.browserRecovery?.staleHeartbeatSeconds || 90) * 1000;
    const stale = Boolean(tab && heartbeatAt && now - heartbeatAt >= staleMs);
    if (tab && !stale) continue;

    if (recoveryEnabled && (authGate || challengeGate)) {
      await recoveryFailed(project.id, "session_gate", authGate ? "auth_gate_detected" : "cloudflare_gate_detected");
      continue;
    }
    if (!recoveryEnabled) {
      const key = `${MISSING_PREFIX}${project.id}`;
      const already = Boolean((await chrome.storage.session.get(key))[key]);
      if (!already) {
        await chrome.storage.session.set({ [key]: true });
        await notifyBridge(project.id, "SESSION_ATTENTION_REQUIRED");
      }
      continue;
    }

    const sameProjectOther = tabs.find((item) => {
      const url = normalizeChatUrl(item.url || "");
      return url !== normalizeChatUrl(project.chatUrl) && sameProjectChat(project.projectRootUrl, url);
    });
    if (!tab && sameProjectOther) {
      await recoveryFailed(project.id, "configured_chat_missing", "same_project_chat_requires_rebind_review");
      continue;
    }
    const status = tab ? await tabRuntimeStatus(tab.id) : null;
    await startRecovery(project, { tab, reason: stale ? "heartbeat_stale" : "tab_missing", status });
  }
}

async function handleRecoverySignal(message, sender) {
  const projectId = String(message.projectId || "");
  const projects = await getProjects();
  const project = projects.find((item) => item.id === projectId);
  if (!project) return { ok: false, error: "unknown_project" };
  if (project.browserRecovery?.enabled !== true) {
    await notifyBridge(project.id, "SESSION_ATTENTION_REQUIRED");
    return { ok: true, recoveryDisabled: true };
  }
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, error: "invalid_sender" };
  const sourceUrl = normalizeChatUrl(sender.tab?.url || "");
  if (sourceUrl !== normalizeChatUrl(project.chatUrl)) return { ok: false, error: "source_not_configured_chat" };
  const status = await tabRuntimeStatus(tabId) || {
    ok: Boolean(message.generatingKnown), generatingKnown: Boolean(message.generatingKnown), generating: Boolean(message.generating), composerPresent: false
  };
  return startRecovery(project, { tab: sender.tab, reason: String(message.reason || "composer_missing"), status });
}

async function handleRecoveryHealthy(message) {
  const projectId = String(message.projectId || "");
  const projects = await getProjects();
  const project = projects.find((item) => item.id === projectId);
  if (!project) return { ok: false, error: "unknown_project" };
  const wasAlerted = Boolean(project.recovery?.alerted);
  await recoveryClear(project.id);
  if (wasAlerted) await notifyBridge(project.id, "RECOVERED").catch(() => {});
  return { ok: true };
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_CONFIG":
      return { ok: true, projects: await getProjects() };
    case "CLAIM":
      return { ok: true, ...(await claim(String(message.projectId || ""), sender)) };
    case "NOTIFY":
      return { ok: true, ...(await notifyBridge(message.projectId, message.event)) };
    case "HEARTBEAT":
      return { ok: true, ...(await heartbeatBridge(message.projectId, message.progressKey, message.status, {
        lastTurnRole: message.lastTurnRole,
        lastTurnId: message.lastTurnId,
        latestAssistantExcerpt: message.latestAssistantExcerpt,
        latestUserExcerpt: message.latestUserExcerpt,
        checkpoint: message.checkpoint || null,
        extensionVersion: chrome.runtime.getManifest().version,
        backgroundWorker: "v17"
      })) };
    case "ROLLOVER":
      return startRollover(message, sender);
    case "ADOPT_CANDIDATE":
      return adoptCandidate(message, sender);
    case "RECOVERY_SIGNAL":
      return handleRecoverySignal(message, sender);
    case "RECOVERY_HEALTHY":
      return handleRecoveryHealthy(message);
    default:
      return { ok: false, error: "unsupported_message" };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: String(error) });
  });
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== PULSE_ALARM) return;
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) continue;
    chrome.tabs.sendMessage(tab.id, { type: "PULSE" }).catch(() => {});
  }
  monitorConfiguredTabs().catch(() => {});
  processRecoveries().catch(() => {});
  processPendingRollovers().catch(() => {});
  processPendingDiscoveries().catch(() => {});
  processPendingMirrorProbes().catch(() => {});
  maybeStartDiscoveryScans().catch(() => {});
  maybeStartMirrorProbe().catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  releaseLeasesForTab(tabId).catch(() => {});
  cleanupMirrorEntriesForTab(tabId).catch(() => {});
  processPendingRollovers().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) releaseLeasesForTab(tabId).catch(() => {});
  if (changeInfo.url || changeInfo.status === "complete") {
    processPendingRollovers().catch(() => {});
    processPendingDiscoveries().catch(() => {});
    processPendingMirrorProbes().catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(ensurePulse);
chrome.runtime.onStartup.addListener(ensurePulse);
ensurePulse().catch(() => {});
