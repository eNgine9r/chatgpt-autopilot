const BRIDGE = "http://127.0.0.1:8765";
const PULSE_ALARM = "autopilot-pulse";
const MONITOR_STARTED_KEY = "monitor:startedAt";
const MISSING_PREFIX = "missing:";
const STARTUP_GRACE_MS = 90000;
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

async function ensurePulse() {
  const alarm = await chrome.alarms.get(PULSE_ALARM);
  if (!alarm) chrome.alarms.create(PULSE_ALARM, { periodInMinutes: 0.5 });
  const current = (await chrome.storage.session.get(MONITOR_STARTED_KEY))[MONITOR_STARTED_KEY];
  if (!current) await chrome.storage.session.set({ [MONITOR_STARTED_KEY]: Date.now() });
}

async function claimUnlocked(projectId, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || !projectId) return { granted: false };
  const key = `lease:${projectId}`;
  const current = (await chrome.storage.session.get(key))[key];
  if (current?.tabId !== undefined && current.tabId !== tabId) {
    try {
      await chrome.tabs.get(current.tabId);
      return { granted: false, tabId: current.tabId };
    } catch {
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

async function monitorConfiguredTabs() {
  const startedAt = Number((await chrome.storage.session.get(MONITOR_STARTED_KEY))[MONITOR_STARTED_KEY] || 0);
  if (!startedAt || Date.now() - startedAt < STARTUP_GRACE_MS) return;

  const config = await bridge("/config");
  const projects = Array.isArray(config.projects) ? config.projects : [];
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const openUrls = new Set(tabs.map((tab) => normalizeChatUrl(tab.url || "")).filter(Boolean));

  for (const project of projects) {
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
      return { ok: true, ...(await bridge("/config")) };
    case "CLAIM":
      return { ok: true, ...(await claim(String(message.projectId || ""), sender)) };
    case "NOTIFY":
      return { ok: true, ...(await notifyBridge(message.projectId, message.event)) };
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
});

chrome.tabs.onRemoved.addListener((tabId) => {
  releaseLeasesForTab(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) releaseLeasesForTab(tabId).catch(() => {});
});

chrome.runtime.onInstalled.addListener(ensurePulse);
chrome.runtime.onStartup.addListener(ensurePulse);
ensurePulse().catch(() => {});
