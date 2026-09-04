import crypto from "node:crypto";

const STAGES = new Set(["active", "complete"]);
const MAX_LIST = 20;

function text(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

function list(value, itemLimit = 500) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, itemLimit)).filter(Boolean).slice(0, MAX_LIST);
}

export function normalizeCheckpoint(input, { planVersion = "v1" } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_checkpoint");
  const claimedPlanVersion = text(input.planVersion, 64);
  if (claimedPlanVersion && claimedPlanVersion !== planVersion) throw new Error("checkpoint_plan_version_mismatch");
  const stage = STAGES.has(String(input.stage || "active")) ? String(input.stage || "active") : "active";
  const githubPr = Number(input.githubPr || 0);
  return {
    goal: text(input.goal, 1200),
    completed: list(input.completed),
    currentTask: text(input.currentTask, 1200),
    decisions: list(input.decisions),
    evidence: list(input.evidence),
    blockers: list(input.blockers),
    nextAction: text(input.nextAction, 1200),
    doNotRepeat: list(input.doNotRepeat),
    planVersion,
    stage,
    githubPr: Number.isInteger(githubPr) && githubPr > 0 ? githubPr : 0
  };
}
export function checkpointFingerprint(checkpoint) {
  return crypto.createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex").slice(0, 24);
}

export function checkpointPromptContract(project) {
  if (project.checkpointLedger?.enabled !== true) return "";
  const version = project.planVersion || "v1";
  return [
    "=== AUTOPILOT CHECKPOINT CONTRACT ===",
    "Після змістовної зміни стану додай наприкінці відповіді один компактний JSON-блок без markdown fence:",
    "[[AUTOPILOT_CHECKPOINT]]",
    `{"goal":"...","completed":[],"currentTask":"...","decisions":[],"evidence":[],"blockers":[],"nextAction":"...","doNotRepeat":[],"planVersion":"${version}","stage":"active","githubPr":0}`,
    "[[/AUTOPILOT_CHECKPOINT]]",
    "Не вигадуй evidence. stage=complete став лише коли фактичний етап справді завершений; Autopilot окремо перевірить configured evidence.",
    "Не змінюй planVersion. Не повторюй незмінений checkpoint без змістовної причини.",
    "=== END AUTOPILOT CHECKPOINT CONTRACT ==="
  ].join("\n");
}

export function checkpointDisplayStatus(checkpoint, evidenceHealth = null) {
  if (!checkpoint?.fingerprint) return "missing";
  if (checkpoint.stage !== "complete") return "active";
  if (!evidenceHealth?.configured) return "complete_claimed";
  return evidenceHealth.ok ? "complete_verified" : "complete_pending_evidence";
}
export function formatCheckpointBlock(checkpoint = null, limit = 6000) {
  if (!checkpoint?.fingerprint) return "";
  const lines = [
    "=== DURABLE PROJECT CHECKPOINT ===",
    `Plan: ${checkpoint.planVersion || "unknown"}`,
    `Goal: ${checkpoint.goal || "—"}`,
    `Current task: ${checkpoint.currentTask || "—"}`,
    checkpoint.completed?.length ? `Completed: ${checkpoint.completed.join(" | ")}` : "",
    checkpoint.decisions?.length ? `Decisions: ${checkpoint.decisions.join(" | ")}` : "",
    checkpoint.evidence?.length ? `Evidence: ${checkpoint.evidence.join(" | ")}` : "",
    checkpoint.blockers?.length ? `Blockers: ${checkpoint.blockers.join(" | ")}` : "",
    `Next action: ${checkpoint.nextAction || "—"}`,
    checkpoint.doNotRepeat?.length ? `Do not repeat: ${checkpoint.doNotRepeat.join(" | ")}` : "",
    `Stage: ${checkpoint.completionStatus || checkpoint.stage || "active"}`,
    "=== END DURABLE PROJECT CHECKPOINT ==="
  ].filter(Boolean);
  return lines.join("\n").slice(0, limit);
}