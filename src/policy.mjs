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
    if (latestTurnRole === "assistant") return "paused_for_user";
    return "ui_unrecognized";
  }

  if (generating) return "wait_generating";

  if (latestTurnRole === "user") return "wait_for_assistant";
  if (latestTurnRole !== "assistant") return "ui_unrecognized";
  if (!latestAssistantText.trim()) return "wait_for_assistant";

  if (latestAssistantText.includes(gateMarker)) return "pause_for_user";

  if (!dueAtMs || nowMs < dueAtMs) return "wait_timer";
  return "send_continue";
}
