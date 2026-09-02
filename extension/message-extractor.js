(() => {
  const MAX_VISITED = 4000;
  const MAX_DEPTH = 10;
  const MAX_FIBER_LEVELS = 12;
  const SKIP_KEYS = new Set([
    "stateNode", "return", "child", "sibling", "alternate",
    "_debugOwner", "_debugInfo", "_owner"
  ]);

  function messageText(candidate, targetId) {
    if (!candidate || typeof candidate !== "object") return "";
    if (!targetId || candidate.id !== targetId) return "";
    if (candidate.author?.role !== "assistant") return "";
    const status = String(candidate.status || "");
    if (status && !["finished_successfully", "finished", "done"].includes(status)) return "";
    const parts = candidate.content?.parts;
    if (!Array.isArray(parts)) return "";
    return parts.filter((part) => typeof part === "string").join("\n").trim();
  }

  function findMessageText(roots, targetId) {
    const queue = roots.map((value) => ({ value, depth: 0 }));
    const seen = new WeakSet();
    let visited = 0;

    while (queue.length && visited < MAX_VISITED) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== "object") continue;
      if (seen.has(value)) continue;
      seen.add(value);
      visited += 1;

      const found = messageText(value, targetId);
      if (found) return found;
      if (depth >= MAX_DEPTH) continue;

      let entries;
      try { entries = Object.entries(value); } catch { continue; }
      for (const [key, child] of entries) {
        if (SKIP_KEYS.has(key)) continue;
        if (!child || typeof child !== "object") continue;
        queue.push({ value: child, depth: depth + 1 });
      }
    }
    return "";
  }

  function reactRoots(messageNode) {
    if (!messageNode || typeof messageNode !== "object") return [];
    const fiberKey = Object.keys(messageNode).find((key) => key.startsWith("__reactFiber$"));
    if (!fiberKey) return [];

    const roots = [];
    let fiber = messageNode[fiberKey];
    for (let level = 0; fiber && level < MAX_FIBER_LEVELS; level += 1) {
      roots.push(fiber.memoizedState, fiber.memoizedProps, fiber.pendingProps, fiber.updateQueue);
      fiber = fiber.return;
    }
    return roots.filter(Boolean);
  }

  function extractAssistantText(messageNode) {
    if (!messageNode) return "";
    const direct = String(messageNode.innerText || "").trim();
    if (direct) return direct;
    const targetId = messageNode.getAttribute?.("data-message-id") || "";
    if (!targetId) return "";
    return findMessageText(reactRoots(messageNode), targetId);
  }

  function latestTurn(documentRef = globalThis.document) {
    if (!documentRef?.querySelectorAll) return { role: "unknown", text: "" };
    const turns = [...documentRef.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')];
    if (turns.length) {
      const turn = turns[turns.length - 1];
      const role = turn.getAttribute("data-turn") || "unknown";
      const roleNode = turn.querySelector?.(`[data-message-author-role="${role}"]`) || null;
      if (role === "assistant") {
        return { role, text: extractAssistantText(roleNode) };
      }
      if (role === "user") {
        return { role, text: String(roleNode?.innerText || turn.innerText || "").trim() };
      }
      return { role: "unknown", text: "" };
    }

    const legacy = [...documentRef.querySelectorAll(
      '[data-message-author-role="assistant"], [data-message-author-role="user"]'
    )];
    if (!legacy.length) return { role: "unknown", text: "" };
    const node = legacy[legacy.length - 1];
    const role = node.getAttribute("data-message-author-role") || "unknown";
    const text = role === "assistant"
      ? extractAssistantText(node)
      : String(node.innerText || "").trim();
    return { role, text };
  }

  globalThis.AutopilotMessageExtractor = Object.freeze({
    messageText,
    findMessageText,
    extractAssistantText,
    latestTurn
  });
})();
