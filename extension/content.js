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

  async function turnText(turn, role) {
    const roleNode = turn.querySelector(`[data-message-author-role="${role}"]`);
    const direct = String(roleNode?.innerText || (role === "user" ? turn.innerText : "") || "").trim();
    if (direct) return direct;
    if (role !== "assistant") return "";
    const messageId = roleNode?.getAttribute("data-message-id") || "";
    return requestAssistantText(messageId);
  }

  async function latestTurn() {
    const turns = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')];
    if (turns.length) {
      const turn = turns[turns.length - 1];
      const role = turn.getAttribute("data-turn") || "unknown";
      const id = turnId(turn);
      if (role === "user" || role === "assistant") {
        return { role, turnId: id, text: await turnText(turn, role) };
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

  async function conversationTail() {
    const turns = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')].slice(-10);
    const parts = [];
    for (const turn of turns) {
      const role = turn.getAttribute("data-turn") || "unknown";
      if (role !== "user" && role !== "assistant") continue;
      const text = await turnText(turn, role);
      if (!text || Policy.isConversationCapacityReached(text)) continue;
      parts.push(`${role === "user" ? "КОРИСТУВАЧ" : "АСИСТЕНТ"}:\n${text.slice(0, 3500)}`);
    }
    return parts.join("\n\n---\n\n").slice(-12000);
  }

  function isGenerating() {
    return Boolean(first(SELECTORS.stop));
  }

  function capacitySurfaceText() {
    const nodes = document.querySelectorAll(
      '[role="alert"], [aria-live="assertive"], [aria-live="polite"], [data-testid*="toast"]'
    );
    return [...nodes]
      .map((node) => String(node.innerText || "").trim())
      .filter(Boolean)
      .join("\n")
      .slice(-6000);
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
      nextAt: project.startImmediately
        ? Date.now() - 1
        : Date.now() + project.continueAfterSeconds * 1000,
      pausedForUser: false,
      rolloverInProgress: false,
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

  async function sendPromptText(prompt) {
    const composer = first(SELECTORS.composer);
    if (!composer || isGenerating()) return false;
    setComposerText(composer, prompt);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const send = first(SELECTORS.send);
    if (!send || send.disabled || send.getAttribute("aria-disabled") === "true") return false;
    send.click();
    return true;
  }

  async function failClosed(state) {
    const failures = Number(state.failures || 0) + 1;
    const shouldNotify = failures === 3;
    await saveState({ failures, lastStatus: "fail_closed" });
    if (shouldNotify) await notify("AUTOMATION_ERROR");
  }

  async function sendContinuation(state) {
    const sent = await sendPromptText(project.continuationPrompt);
    if (!sent) return failClosed(state);
    await saveState({
      nextAt: Date.now() + project.continueAfterSeconds * 1000,
      sentCount: Number(state.sentCount || 0) + 1,
      failures: 0,
      lastStatus: "continue_sent"
    });
  }

  async function requestRollover(state) {
    const handoff = await conversationTail();
    await saveState({
      rolloverInProgress: true,
      failures: 0,
      lastStatus: "rollover_requested"
    });
    const response = await message({ type: "ROLLOVER", projectId: project.id, handoff });
    if (response?.ok) return;
    await saveState({
      rolloverInProgress: false,
      pausedForUser: true,
      lastStatus: "rollover_failed"
    });
    await notify("AUTOMATION_ERROR");
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
      if (state.rolloverInProgress) return;
      const latest = await latestTurn();
      const generating = isGenerating();

      if (
        project.autoRollover
        && !generating
        && Policy.isConversationCapacityReached(`${latest.text}\n${capacitySurfaceText()}`)
      ) {
        await requestRollover(state);
        return;
      }

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

  chrome.runtime.onMessage.addListener((payload, _sender, sendResponse) => {
    if (payload?.type === "PULSE") {
      inspect();
      return false;
    }
    if (payload?.type === "ROLLOVER_SEND") {
      sendPromptText(String(payload.prompt || ""))
        .then((ok) => sendResponse({ ok }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    return false;
  });

  new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(inspect, 800);
  }).observe(document.documentElement, { childList: true, subtree: true });

  setInterval(inspect, 5000);
  setTimeout(inspect, 1500);
})();
