(() => {
  function normalizeChatUrl(raw) {
    try {
      const url = new URL(raw);
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      return `${url.origin}${pathname}`;
    } catch {
      return "";
    }
  }

  function decideAction({
    enabled,
    generating,
    pausedForUser,
    latestTurnRole,
    latestAssistantText,
    gateMarker,
    nowMs,
    dueAtMs
  }) {
    if (!enabled) return "disabled";
    if (pausedForUser) {
      if (latestTurnRole === "user") return "resume_from_user";
      return "paused_for_user";
    }
    if (generating) return "wait_generating";
    if (latestTurnRole !== "assistant") return "fail_closed";
    if (!String(latestAssistantText || "").trim()) return "fail_closed";
    if (latestAssistantText.includes(gateMarker)) return "pause_for_user";
    if (!dueAtMs || nowMs < dueAtMs) return "wait_timer";
    return "send_continue";
  }

  function shouldResumeFromTurns(turns, gateTurnId) {
    if (!gateTurnId || !Array.isArray(turns)) return false;
    const index = turns.findIndex((turn) => turn?.turnId === gateTurnId);
    if (index < 0) return false;
    return turns.slice(index + 1).some((turn) => turn?.role === "user");
  }

  function fingerprint(text) {
    let hash = 2166136261;
    for (const ch of String(text || "").slice(-1000)) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  globalThis.AutopilotPolicy = Object.freeze({
    normalizeChatUrl,
    decideAction,
    shouldResumeFromTurns,
    fingerprint
  });
})();
