import { checkpointPromptContract, formatCheckpointBlock } from "./checkpoint-ledger.mjs";
function bounded(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

export function planAnchorBlock(project, limit = 6000) {
  const anchor = bounded(project.planAnchor, limit);
  if (!anchor) return "";
  return `\n\n=== AUTOPILOT PLAN ANCHOR (${project.planVersion || "v1"}) ===\n${anchor}\n=== END PLAN ANCHOR ===`;
}

export function composeContinuationPrompt(project) {
  return [bounded(project.continuationPrompt, 9000), planAnchorBlock(project).trim(), checkpointPromptContract(project)]
    .filter(Boolean).join("\n\n").slice(0, 18000);
}

export function composeRolloverPrompt(project, handoff = "", checkpoint = null) {
  const checkpointText = formatCheckpointBlock(checkpoint?.checkpoint, 6000) || (checkpoint ? [
    "=== DURABLE CHECKPOINT ===",
    `Last status: ${checkpoint.runtime?.status || "unknown"}`,
    checkpoint.runtime?.latestUserExcerpt ? `Latest user: ${checkpoint.runtime.latestUserExcerpt}` : "",
    checkpoint.runtime?.latestAssistantExcerpt ? `Latest assistant: ${checkpoint.runtime.latestAssistantExcerpt}` : "",
    "=== END CHECKPOINT ==="
  ].filter(Boolean).join("\n") : "");
  return [
    bounded(project.rolloverPrompt, 3500),
    planAnchorBlock(project, 4000).trim(),
    checkpointText,
    checkpointPromptContract(project),
    handoff ? `=== BOUNDED CHAT TAIL ===\n${bounded(handoff, 12000)}\n=== END CHAT TAIL ===` : ""
  ].filter(Boolean).join("\n\n").slice(0, 15000);
}
