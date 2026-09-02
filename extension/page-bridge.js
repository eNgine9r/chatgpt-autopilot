(() => {
  const REQUEST_SOURCE = "chatgpt-autopilot-isolated";
  const RESPONSE_SOURCE = "chatgpt-autopilot-main";
  const Extractor = globalThis.AutopilotMessageExtractor;

  function validMessageId(value) {
    return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  }

  function findMessageNode(messageId) {
    for (const node of document.querySelectorAll('[data-message-author-role="assistant"][data-message-id]')) {
      if (node.getAttribute("data-message-id") === messageId) return node;
    }
    return null;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const payload = event.data;
    if (!payload || payload.source !== REQUEST_SOURCE || payload.type !== "EXTRACT_ASSISTANT") return;
    if (!validMessageId(payload.messageId) || typeof payload.requestId !== "string") return;

    const node = findMessageNode(payload.messageId);
    const text = node && Extractor?.extractAssistantText
      ? Extractor.extractAssistantText(node)
      : "";

    window.postMessage({
      source: RESPONSE_SOURCE,
      type: "EXTRACT_ASSISTANT_RESULT",
      requestId: payload.requestId.slice(0, 128),
      messageId: payload.messageId,
      text: String(text || "").slice(0, 200000)
    }, "*");
  });
})();
