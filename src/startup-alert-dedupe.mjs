import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

function alertStatePath(stateDir, projectId) {
  return path.join(stateDir, `${projectId}.startup-alert.json`);
}

export function normalizeStartupError(error) {
  return String(error || "unknown error")
    .trim()
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>")
    .replace(/\bthr_[A-Za-z0-9_-]+\b/g, "<thread>")
    .replace(/\s+/g, " ");
}

export function startupErrorFingerprint(error) {
  return crypto.createHash("sha256").update(normalizeStartupError(error)).digest("hex");
}

function readAlertState(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
export function shouldSendStartupAlert(stateDir, projectId, error, {
  now = () => Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS
} = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = alertStatePath(stateDir, projectId);
  const fingerprint = startupErrorFingerprint(error);
  const previous = readAlertState(file);
  const at = now();
  const duplicate = previous.fingerprint === fingerprint
    && Number.isFinite(previous.sentAt)
    && at - previous.sentAt < cooldownMs;

  if (duplicate) return false;

  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ fingerprint, sentAt: at }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return true;
}

export function clearStartupAlert(stateDir, projectId) {
  const file = alertStatePath(stateDir, projectId);
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
