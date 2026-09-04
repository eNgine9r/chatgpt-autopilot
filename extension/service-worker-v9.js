importScripts("lease-policy.js", "discovery-policy.js");
const BRIDGE = "http://127.0.0.1:8765";
const PULSE_ALARM = "autopilot-pulse";
const MONITOR_STARTED_KEY = "monitor:startedAt";
const MISSING_PREFIX = "missing:";
const ROLLOVER_PREFIX = "rollover:";
const DISCOVERY_PREFIX = "discovery:";
const DISCOVERY_LAST_PREFIX = "discovery-last:";
const STARTUP_GRACE_MS = 90000;
const ROLLOVER_TIMEOUT_MS = 120000;
const DISCOVERY_TIMEOUT_MS = 90000;
const LEASE_TTL_MS = 90000;
const claimChains = new Map();

async function bridge(path, options = {}) {
  const response = await fetch(`${BRIDGE}${path}`, options);
  if (!response.ok) throw new Error(`bridge_http_${response.status}`);
  return response.json();
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
    if (!project?.chatDiscovery?.enabled || Date.now() - Number(entry.startedAt || 0) > DISCOVERY_TIMEOUT_MS) {
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
  return performAdoption(project, tabId, project.discovery, "manual");
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
  const checkpoint = project.runtimeCheckpoint || {};
  const checkpointText = [
    "=== DURABLE CHECKPOINT ===",
    `Last status: ${checkpoint.status || "unknown"}`,
    checkpoint.latestUserExcerpt ? `Latest user: ${checkpoint.latestUserExcerpt}` : "",
    checkpoint.latestAssistantExcerpt ? `Latest assistant: ${checkpoint.latestAssistantExcerpt}` : "",
    "=== END CHECKPOINT ==="
  ].filter(Boolean).join("\n");
  const prompt = `${project.rolloverPrompt}\n\n${checkpointText}\n\n=== BOUNDED CHAT TAIL ===\n${handoff}\n=== END CHAT TAIL ===`.slice(0, 20000);
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

async function monitorConfiguredTabs() {
  const startedAt = Number((await chrome.storage.session.get(MONITOR_STARTED_KEY))[MONITOR_STARTED_KEY] || 0);
  if (!startedAt || Date.now() - startedAt < STARTUP_GRACE_MS) return;

  const projects = await getProjects();
  const pending = new Set((await rolloverEntries()).map((entry) => entry.projectId));
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const openUrls = new Set(tabs.map((tab) => normalizeChatUrl(tab.url || "")).filter(Boolean));

  for (const project of projects) {
    if (pending.has(project.id)) continue;
    const key = `${MISSING_PREFIX}${project.id}`;
    const missing = !openUrls.has(normalizeChatUrl(project.chatUrl));
    const wasMissing = Boolean((await chrome.storage.session.get(key))[key]);
    if (missing && !wasMissing) {
      await chrome.storage.session.set({ [key]: true });
      await notifyBridge(project.id, "SESSION_ATTENTION_REQUIRED");
    } else if (!missing && wasMissing) {
      await chrome.storage.session.remove(key);
      await notifyBridge(project.id, "RECOVERED");
    }
  }
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
        latestUserExcerpt: message.latestUserExcerpt
      })) };
    case "ROLLOVER":
      return startRollover(message, sender);
    case "ADOPT_CANDIDATE":
      return adoptCandidate(message, sender);
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
  processPendingRollovers().catch(() => {});
  processPendingDiscoveries().catch(() => {});
  maybeStartDiscoveryScans().catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  releaseLeasesForTab(tabId).catch(() => {});
  processPendingRollovers().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) releaseLeasesForTab(tabId).catch(() => {});
  if (changeInfo.url || changeInfo.status === "complete") {
    processPendingRollovers().catch(() => {});
    processPendingDiscoveries().catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(ensurePulse);
chrome.runtime.onStartup.addListener(ensurePulse);
ensurePulse().catch(() => {});
