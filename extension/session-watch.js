(() => {
  const Policy = globalThis.AutopilotPolicy;
  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    'textarea[data-testid="prompt-textarea"]',
    'div.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"][data-lexical-editor="true"]'
  ];
  const ISSUE_DELAY_MS = 30000;
  let issueSince = null;
  let alerted = false;
  let running = false;

  function hasComposer() {
    return COMPOSER_SELECTORS.some((selector) => document.querySelector(selector));
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
      if (!project) {
        issueSince = null;
        alerted = false;
        return;
      }
      if (hasComposer()) {
        issueSince = null;
        if (alerted) {
          alerted = false;
          await send({ type: "NOTIFY", projectId: project.id, event: "RECOVERED" });
        }
        return;
      }
      if (!issueSince) issueSince = Date.now();
      if (!alerted && Date.now() - issueSince >= ISSUE_DELAY_MS) {
        alerted = true;
        await send({
          type: "NOTIFY",
          projectId: project.id,
          event: "SESSION_ATTENTION_REQUIRED"
        });
      }
    } finally {
      running = false;
    }
  }

  setInterval(check, 5000);
  setTimeout(check, 2000);
})();
