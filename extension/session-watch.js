(() => {
  const Policy = globalThis.AutopilotPolicy;
  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    'textarea[data-testid="prompt-textarea"]',
    'div.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"][data-lexical-editor="true"]'
  ];
  const STOP_SELECTORS = [
    'button[data-testid="stop-button"]', '#composer-stop-button',
    'button[aria-label*="Stop"]', 'button[title*="Stop"]',
    'button[aria-label*="Зупин"]', 'button[title*="Зупин"]'
  ];
  const ISSUE_DELAY_MS = 30000;
  let issueSince = null;
  let signaled = false;
  let running = false;

  function hasAny(selectors) { return selectors.some((selector) => document.querySelector(selector)); }
  function hasComposer() { return hasAny(COMPOSER_SELECTORS); }
  function isGenerating() { return hasAny(STOP_SELECTORS); }
  function generationStateKnown() {
    if (document.readyState !== "complete") return false;
    return Boolean(
      document.querySelector('[data-testid^="conversation-turn-"][data-turn]')
      || document.querySelector('[data-message-author-role="assistant"], [data-message-author-role="user"]')
      || hasComposer()
    );
  }

  async function send(payload) {
    try { return await chrome.runtime.sendMessage(payload); }
    catch { return null; }
  }

  async function configuredProject() {
    const response = await send({ type: "GET_CONFIG" });
    if (!response?.ok || !Array.isArray(response.projects)) return null;
    const current = Policy.normalizeChatUrl(location.href);
    return response.projects.find((project) =>
      project.enabled !== false && Policy.normalizeChatUrl(project.chatUrl) === current
    ) || null;
  }

  async function check() {
    if (running) return;
    running = true;
    try {
      const project = await configuredProject();
      if (!project) { issueSince = null; signaled = false; return; }
      if (hasComposer()) {
        issueSince = null;
        if (signaled) {
          signaled = false;
          await send({ type: "RECOVERY_HEALTHY", projectId: project.id });
        }
        return;
      }
      if (!issueSince) issueSince = Date.now();
      if (!signaled && Date.now() - issueSince >= ISSUE_DELAY_MS) {
        signaled = true;
        await send({
          type: "RECOVERY_SIGNAL", projectId: project.id,
          reason: "composer_missing", generatingKnown: generationStateKnown(), generating: isGenerating()
        });
      }
    } finally { running = false; }
  }

  setInterval(check, 5000);
  setTimeout(check, 2000);
})();
