(() => {
  if (globalThis.__CHATGPT_PROJECT_AUTOPILOT__) return;
  globalThis.__CHATGPT_PROJECT_AUTOPILOT__ = true;

  const Policy = globalThis.AutopilotPolicy;
  const REQUEST_SOURCE = "chatgpt-autopilot-isolated";
  const RESPONSE_SOURCE = "chatgpt-autopilot-main";
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
  let requestCounter = 0;

  function first(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  function turnId(turn) {
    return turn?.getAttribute("data-turn-id")
      || turn?.getAttribute("data-turn-id-container")
      || turn?.getAttribute("data-testid")
      || "";
  }

  function conversationOrder() {
    return [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')]
      .map((turn) => ({ turnId: turnId(turn), role: turn.getAttribute("data-turn") || "unknown" }))
      .filter((turn) => turn.turnId);
  }

  function requestAssistantText(messageId) {
    if (!messageId) return Promise.resolve("");
    const requestId = `${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;
    return new Promise((resolve) => {
      let done = false;
      const finish = (text) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(String(text || "").trim());
      };
      const onMessage = (event) => {
        if (event.source !== window) return;
        const payload = event.data;
        if (!payload || payload.source !== RESPONSE_SOURCE) return;
        if (payload.type !== "EXTRACT_ASSISTANT_RESULT" || payload.requestId !== requestId) return;
        if (payload.messageId !== messageId) return;
        finish(payload.text);
      };
      const timer = setTimeout(() => finish(""), 800);
      window.addEventListener("message", onMessage);
      window.postMessage({
        source: REQUEST_SOURCE,
        type: "EXTRACT_ASSISTANT",
        requestId,
        messageId
      }, "*");
    });
  }

  async function latestTurn() {
    const turns = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')];
    if (turns.length) {
      const turn = turns[turns.length - 1];
      const role = turn.getAttribute("data-turn") || "unknown";
      const roleNode = turn.querySelector(`[data-message-author-role="${role}"]`);
      const id = turnId(turn);
      if (role === "user") {
        return { role, turnId: id, text: String(roleNode?.innerText || turn.innerText || "").trim() };
      }
      if (role === "assistant") {
        const direct = String(roleNode?.innerText || "").trim();
        if (direct) return { role, turnId: id, text: direct };
        const messageId = roleNode?.getAttribute("data-message-id") || "";
        return { role, turnId: id, text: await requestAssistantText(messageId) };
      }
      return { role: "unknown", turnId: id, text: "" };
    }

    const legacy = [...document.querySelectorAll(
      '[data-message-author-role="assistant"], [data-message-author-role="user"]'
    )];
    if (!legacy.length) return { role: "unknown", turnId: "", text: "" };
    const node = legacy[legacy.length - 1];
    const role = node.getAttribute("data-message-author-role") || "unknown";
    const id = node.getAttribute("data-message-id") || "";
    if (role === "assistant") {
      const direct = String(node.innerText || "").trim();
      if (direct) return { role, turnId: id, text: direct };
      return { role, turnId: id, text: await requestAssistantText(id) };
    }
    return { role, turnId: id, text: String(node.innerText || "").trim() };
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
      lastGateTurnId: null,
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

  async function resumeAfterUser() {
    await saveState({
      pausedForUser: false,
      nextAt: Date.now() + project.continueAfterSeconds * 1000,
      failures: 0,
      lastStatus: "resumed_after_user"
    });
    await notify("RECOVERED");
  }

  async function inspect() {
    if (inspecting) return;
    inspecting = true;
    try {
      if (!await refreshProject()) return;
      if (!await claim()) return;
      const state = await loadState();
      const latest = await latestTurn();
      const generating = isGenerating();

      if (
        state.pausedForUser
        && state.lastGateTurnId
        && Policy.shouldResumeFromTurns(conversationOrder(), state.lastGateTurnId)
      ) {
        await resumeAfterUser();
        return;
      }

      if (latest.role === "assistant" && latest.text.includes(project.userGateMarker)) {
        const fp = Policy.fingerprint(latest.text);
        if (!state.pausedForUser || state.lastGateFingerprint !== fp) {
          await saveState({
            pausedForUser: true,
            lastGateFingerprint: fp,
            lastGateTurnId: latest.turnId || null,
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
        await resumeAfterUser();
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
