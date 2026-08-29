export function decideAction({
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

  if (latestTurnRole === "assistant" && latestAssistantText.includes(gateMarker)) {
    return "pause_for_user";
  }

  if (!dueAtMs || nowMs < dueAtMs) return "wait_timer";
  return "send_continue";
}
