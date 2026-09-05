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

  const CAPACITY_PATTERNS = [
    /you(?:'|’)ve reached the maximum length for this conversation/i,
    /this conversation (?:has )?reached (?:its|the) maximum length/i,
    /maximum conversation length (?:has been )?reached/i,
    /this conversation is too long to continue/i,
    /досягнуто максимальної довжини (?:цієї )?(?:розмови|чату)/i,
    /(?:ця розмова|цей чат) (?:вже )?досяг(?:ла|) максимальної довжини/i,
    /(?:ця розмова|цей чат) надто довг(?:а|ий),? щоб продовжувати/i,
    /достигнута максимальная длина (?:этого )?(?:разговора|чата)/i,
    /(?:этот разговор|этот чат) достиг максимальной длины/i
  ];

  function isConversationCapacityReached(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return false;
    return CAPACITY_PATTERNS.some((pattern) => pattern.test(value));
  }

  function shouldRequestCapacityRollover({ autoRollover, generating, latestTurnRole, latestTurnText, capacitySurfaceText }) {
    if (!autoRollover || generating) return false;
    const assistantCapacity = latestTurnRole === "assistant" && isConversationCapacityReached(latestTurnText);
    const surfaceCapacity = isConversationCapacityReached(capacitySurfaceText);
    return assistantCapacity || surfaceCapacity;
  }

  function decideAction({
    enabled,
    generating,
    pausedForUser,
    latestTurnRole,
    latestAssistantText,
    gateMarker,
    nowMs,
    dueAtMs,
    autoContinueMode = "timer",
    assistantFinished = null,
    latestTurnKey = "",
    lastContinuedTurnKey = "",
    completionObservedTurnKey = "",
    completionObservedAtMs = 0,
    completionSettleMs = 0,
    stableIdleEligible = false,
    stableIdleObservationKey = "",
    stableIdleSettleMs = 30000
  }) {
    if (!enabled) return "disabled";
    if (pausedForUser) {
      if (latestTurnRole === "user") return "resume_from_user";
      return "paused_for_user";
    }
    if (generating) return "wait_generating";

    if (autoContinueMode === "on_completion" && latestTurnRole === "user") {
      return "wait_assistant";
    }
    if (latestTurnRole !== "assistant") return "fail_closed";
    if (!String(latestAssistantText || "").trim()) return "fail_closed";
    if (latestAssistantText.includes(gateMarker)) return "pause_for_user";

    if (autoContinueMode === "on_completion") {
      if (assistantFinished === false) return "wait_completion";
      if (!latestTurnKey) return "fail_closed";
      if (lastContinuedTurnKey === latestTurnKey) return "wait_next_turn";

      let observationKey = latestTurnKey;
      let settleMs = Number(completionSettleMs || 0);
      if (assistantFinished !== true) {
        if (!stableIdleEligible || !String(stableIdleObservationKey || "")) return "fail_closed";
        observationKey = String(stableIdleObservationKey);
        settleMs = Math.max(settleMs, Number(stableIdleSettleMs || 0));
      }
      if (completionObservedTurnKey !== observationKey || !completionObservedAtMs) {
        return "observe_completion";
      }
      if (nowMs < completionObservedAtMs + settleMs) return "wait_settle";
      return "send_continue";
    }

    if (!dueAtMs || nowMs < dueAtMs) return "wait_timer";
    return "send_continue";
  }

  function shouldResumeFromTurns(turns, gateTurnId) {
    if (!gateTurnId || !Array.isArray(turns)) return false;
    const index = turns.findIndex((turn) => turn?.turnId === gateTurnId);
    if (index < 0) return false;
    return turns.slice(index + 1).some((turn) => turn?.role === "user");
  }


  function shouldResumeFromLatestAssistant({ pausedForUser, gateTurnId, latestTurnRole, latestTurnId, latestAssistantText, gateMarker }) {
    return Boolean(
      pausedForUser
      && gateTurnId
      && latestTurnRole === "assistant"
      && latestTurnId
      && latestTurnId !== gateTurnId
      && !String(latestAssistantText || "").includes(String(gateMarker || ""))
    );
  }

  function isStartupGraceActive(nowMs, startedAtMs, graceMs) {
    const now = Number(nowMs || 0);
    const started = Number(startedAtMs || 0);
    const grace = Number(graceMs || 0);
    return started > 0 && grace > 0 && now >= started && now < started + grace;
  }

  function refreshedWatchdogAt({
    watchdogAtMs,
    previousProgressKey,
    currentProgressKey,
    nowMs,
    watchdogMs
  }) {
    const current = String(currentProgressKey || "");
    const previous = String(previousProgressKey || "");
    const deadline = Number(watchdogAtMs || 0);
    if (!deadline) return 0;
    if (!current || current === previous) return deadline;
    return Number(nowMs || 0) + Number(watchdogMs || 0);
  }

  function recoveryWatchdogDeadline({
    watchdogAtMs,
    lastProgressAtMs,
    nowMs,
    watchdogMs
  }) {
    const existing = Number(watchdogAtMs || 0);
    if (existing > 0) return existing;
    const now = Number(nowMs || 0);
    const lastProgress = Number(lastProgressAtMs || 0);
    const anchor = lastProgress > 0 ? lastProgress : now;
    return anchor + Number(watchdogMs || 0);
  }

  function shouldCheckRecoveryWatchdog(action) {
    return [
      "wait_generating",
      "wait_assistant",
      "wait_completion",
      "wait_next_turn",
      "fail_closed"
    ].includes(String(action || ""));
  }

  function shouldAutoRolloverForStall({
    autoRollover,
    pausedForUser,
    rolloverInProgress,
    nowMs,
    watchdogAtMs
  }) {
    const deadline = Number(watchdogAtMs || 0);
    return Boolean(
      autoRollover
      && !pausedForUser
      && !rolloverInProgress
      && deadline > 0
      && Number(nowMs || 0) >= deadline
    );
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
    shouldResumeFromLatestAssistant,
    fingerprint,
    isConversationCapacityReached,
    shouldRequestCapacityRollover,
    isStartupGraceActive,
    refreshedWatchdogAt,
    recoveryWatchdogDeadline,
    shouldCheckRecoveryWatchdog,
    shouldAutoRolloverForStall
  });
})();
