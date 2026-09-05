(() => {
  const STOP_SELECTORS = Object.freeze([
    'button[data-testid="stop-button"]',
    '#composer-stop-button',
    'button[aria-label="Stop generating" i]',
    'button[title="Stop generating" i]',
    'button[aria-label="Stop response" i]',
    'button[title="Stop response" i]',
    'button[aria-label="Stop streaming" i]',
    'button[title="Stop streaming" i]',
    'button[aria-label="Зупинити генерування"]',
    'button[aria-label="Зупинити відповідь"]',
    'button[aria-label="Зупинити створення відповіді"]',
    'button[aria-label="Остановить генерацию"]',
    'button[aria-label="Остановить ответ"]'
  ]);

  function isVisibleInteractiveControl(node, windowRef = globalThis) {
    if (!node || node.isConnected === false || node.hidden || node.disabled) return false;
    if (String(node.getAttribute?.("aria-hidden") || "").toLowerCase() === "true") return false;
    if (String(node.getAttribute?.("aria-disabled") || "").toLowerCase() === "true") return false;
    let style = null;
    try { style = windowRef.getComputedStyle?.(node) || null; } catch {}
    if (style && ["none"].includes(String(style.display || "").toLowerCase())) return false;
    if (style && ["hidden", "collapse"].includes(String(style.visibility || "").toLowerCase())) return false;
    try {
      const rect = node.getBoundingClientRect?.();
      if (rect && (!(Number(rect.width) > 0) || !(Number(rect.height) > 0))) return false;
    } catch {}
    return true;
  }

  function findGenerationStop(documentRef = globalThis.document, windowRef = globalThis) {
    if (!documentRef?.querySelectorAll) return null;
    for (const selector of STOP_SELECTORS) {
      let nodes = [];
      try { nodes = [...documentRef.querySelectorAll(selector)]; } catch { continue; }
      for (const node of nodes) {
        if (isVisibleInteractiveControl(node, windowRef)) return node;
      }
    }
    return null;
  }

  function isGenerating(documentRef = globalThis.document, windowRef = globalThis) {
    return Boolean(findGenerationStop(documentRef, windowRef));
  }

  globalThis.AutopilotGenerationPolicy = Object.freeze({
    STOP_SELECTORS,
    isVisibleInteractiveControl,
    findGenerationStop,
    isGenerating
  });
})();
