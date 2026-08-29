(() => {
  if (globalThis.__CHATGPT_PROJECT_AUTOPILOT__) return;
  globalThis.__CHATGPT_PROJECT_AUTOPILOT__ = true;

  const Policy = globalThis.AutopilotPolicy;
  const SELECTORS = {
    stop: [
      'button[data-testid="stop-button"]',
      '#composer-stop-button',
      'button[aria-label*="Stop"]',
      'button[title*="Stop"]',
      'button[aria-label*="Зупин"]',
      'button[title*="Зупин"]'
    ],
    composer: [
      '#prompt-textarea',
      'textarea[data-testid="prompt-textarea"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="Повідом"]',
      'div.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"][data-lexical-editor="true"]'
    ],
    send: [
      '#composer-submit-button',
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="Надісл"]'
    ]
  };

  let project = null;
  let lastUrl = "";
  let inspecting = false;
  let mutationTimer = null;

  function first(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  function latestTurn() {
    const turns = [...document.querySelectorAll(
      '[data-message-author-role="assistant"], [data-message-author-role="user"]'
    )];
    if (!turns.length) return { role: "unknown", text: "" };
    const node = turns[turns.length - 1];
    return {
      role: node.getAttribute("data-message-author-role") || "unknown",
      text: (node.innerText || "").trim()
    };
  }

  function isGenerating() {
    return Boolean(first(SELECTORS.stop));
  }

  function stateKey() {
    return `project:${project.id}`;
  }

  async function message(payload) {
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  async function refreshProject() {
    const current = Policy.normalizeChatUrl(location.href);
    if (current === lastUrl && project) return project;
    lastUrl = current;
    const response = await message({ type: "GET_CONFIG" });
    if (!response?.ok || !Array.isArray(response.projects)) {
      project = null;
      return null;
    }
    project = response.projects.find((item) =>
      item.enabled !== false && Policy.normalizeChatUrl(item.chatUrl) === current
    ) || null;
    return project;
  }

  async function loadState() {
    const key = stateKey();
    const found = (await chrome.storage.local.get(key))[key];
    if (found) return found;
    const initial = {
      nextAt: Date.now() + project.continueAfterSeconds * 1000,
      pausedForUser: false,
      sentCount: 0,
      failures: 0,
      lastGateFingerprint: null,
      lastStatus: "armed"
    };
    await chrome.storage.local.set({ [key]: initial });
    return initial;
  }

  async function saveState(patch) {
    const key = stateKey();
    const current = (await chrome.storage.local.get(key))[key] || {};
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await chrome.storage.local.set({ [key]: next });
    return next;
  }

  async function notify(event) {
    await message({ type: "NOTIFY", projectId: project.id, event });
  }

  async function claim() {
    const response = await message({ type: "CLAIM", projectId: project.id });
    return Boolean(response?.ok && response.granted);
  }

  function setComposerText(editor, text) {
    editor.focus();
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const proto = Object.getPrototypeOf(editor);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(editor, text); else editor.value = text;
    } else {
      editor.textContent = "";
      if (!document.execCommand("insertText", false, text)) editor.textContent = text;
    }
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
  }

  async function failClosed(state) {
    const failures = Number(state.failures || 0) + 1;
    const shouldNotify = failures === 3;
    await saveState({ failures, lastStatus: "fail_closed" });
    if (shouldNotify) await notify("AUTOMATION_ERROR");
  }

  async function sendContinuation(state) {
    const composer = first(SELECTORS.composer);
    if (!composer) return failClosed(state);
    setComposerText(composer, project.continuationPrompt);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const send = first(SELECTORS.send);
    if (!send || send.disabled || send.getAttribute("aria-disabled") === "true") {
      return failClosed(state);
    }
    send.click();
    await saveState({
      nextAt: Date.now() + project.continueAfterSeconds * 1000,
      sentCount: Number(state.sentCount || 0) + 1,
      failures: 0,
      lastStatus: "continue_sent"
    });
  }

  async function inspect() {
    if (inspecting) return;
    inspecting = true;
    try {
      if (!await refreshProject()) return;
      if (!await claim()) return;
      const state = await loadState();
      const latest = latestTurn();
      const generating = isGenerating();

      if (latest.role === "assistant" && latest.text.includes(project.userGateMarker)) {
        const fp = Policy.fingerprint(latest.text);
        if (!state.pausedForUser || state.lastGateFingerprint !== fp) {
          await saveState({
            pausedForUser: true,
            lastGateFingerprint: fp,
            failures: 0,
            lastStatus: "user_action_required"
          });
          await notify("USER_ACTION_REQUIRED");
        }
        return;
      }

      const action = Policy.decideAction({
        enabled: project.enabled !== false,
        generating,
        pausedForUser: Boolean(state.pausedForUser),
        latestTurnRole: latest.role,
        latestAssistantText: latest.role === "assistant" ? latest.text : "",
        gateMarker: project.userGateMarker,
        nowMs: Date.now(),
        dueAtMs: state.nextAt
      });

      if (action === "resume_from_user") {
        await saveState({
          pausedForUser: false,
          nextAt: Date.now() + project.continueAfterSeconds * 1000,
          failures: 0,
          lastStatus: "resumed_after_user"
        });
        return;
      }
      if (action === "send_continue") return sendContinuation(state);
      if (action === "fail_closed" && Date.now() >= Number(state.nextAt || 0)) {
        return failClosed(state);
      }
      if (action === "wait_generating") {
        await saveState({ failures: 0, lastStatus: "working" });
      } else if (action === "paused_for_user") {
        await saveState({ lastStatus: "user_action_required" });
      } else if (state.failures) {
        await saveState({ failures: 0, lastStatus: "armed" });
      }
    } finally {
      inspecting = false;
    }
  }

  chrome.runtime.onMessage.addListener((payload) => {
    if (payload?.type === "PULSE") inspect();
  });

  new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(inspect, 800);
  }).observe(document.documentElement, { childList: true, subtree: true });

  setInterval(inspect, 5000);
  setTimeout(inspect, 1500);
})();
