function bounded(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

export function planAnchorBlock(project) {
  const anchor = bounded(project.planAnchor, 6000);
  if (!anchor) return "";
  return `\n\n=== AUTOPILOT PLAN ANCHOR (${project.planVersion || "v1"}) ===\n${anchor}\n=== END PLAN ANCHOR ===`;
}

export function composeContinuationPrompt(project) {
  return `${bounded(project.continuationPrompt, 9000)}${planAnchorBlock(project)}`.slice(0, 15000);
}

export function composeRolloverPrompt(project, handoff = "", checkpoint = null) {
  const checkpointText = checkpoint ? [
    "=== DURABLE CHECKPOINT ===",
    `Last status: ${checkpoint.runtime?.status || "unknown"}`,
    checkpoint.runtime?.latestUserExcerpt ? `Latest user: ${checkpoint.runtime.latestUserExcerpt}` : "",
    checkpoint.runtime?.latestAssistantExcerpt ? `Latest assistant: ${checkpoint.runtime.latestAssistantExcerpt}` : "",
    "=== END CHECKPOINT ==="
  ].filter(Boolean).join("\n") : "";
  return [
    bounded(project.rolloverPrompt, 7000),
    planAnchorBlock(project).trim(),
    checkpointText,
    handoff ? `=== BOUNDED CHAT TAIL ===\n${bounded(handoff, 12000)}\n=== END CHAT TAIL ===` : ""
  ].filter(Boolean).join("\n\n").slice(0, 20000);
}
