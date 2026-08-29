const BRIDGE = "http://127.0.0.1:8765";
const PULSE_ALARM = "autopilot-pulse";

async function bridge(path, options = {}) {
  const response = await fetch(`${BRIDGE}${path}`, options);
  if (!response.ok) throw new Error(`bridge_http_${response.status}`);
  return response.json();
}

async function ensurePulse() {
  const alarm = await chrome.alarms.get(PULSE_ALARM);
  if (!alarm) chrome.alarms.create(PULSE_ALARM, { periodInMinutes: 0.5 });
}

async function claim(projectId, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return { granted: false };
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

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_CONFIG":
      return { ok: true, ...(await bridge("/config")) };
    case "CLAIM":
      return { ok: true, ...(await claim(String(message.projectId || ""), sender)) };
    case "NOTIFY":
      return {
        ok: true,
        ...(await bridge("/event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: message.projectId, event: message.event })
        }))
      };
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
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const all = await chrome.storage.session.get(null);
  const remove = Object.entries(all)
    .filter(([key, value]) => key.startsWith("lease:") && value?.tabId === tabId)
    .map(([key]) => key);
  if (remove.length) await chrome.storage.session.remove(remove);
});

chrome.runtime.onInstalled.addListener(ensurePulse);
chrome.runtime.onStartup.addListener(ensurePulse);
ensurePulse().catch(() => {});
