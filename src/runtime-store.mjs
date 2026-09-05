import fs from "node:fs";
import path from "node:path";

function safeId(value) {
  return String(value || "").replace(/[^a-z0-9_-]/gi, "_");
}

export class ProjectRuntimeStore {
  constructor({ stateDir, projects, now = () => Date.now() }) {
    this.dir = path.join(stateDir, "projects");
    this.projects = new Set(projects.map((project) => project.id));
    this.now = now;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  file(projectId) {
    return path.join(this.dir, `${safeId(projectId)}.json`);
  }

  empty(projectId) {
    return {
      version: 1,
      projectId,
      control: { paused: false, restartGeneration: 0, rolloverGeneration: 0, adoptGeneration: 0, discoveryScanGeneration: 0 },
      runtime: { lastSeenAt: 0, lastProgressAt: 0, progressKey: "", status: "unknown" },
      discovery: {
        lastScanAt: 0, candidateUrl: "", candidateTitle: "", candidatePreview: "", candidateSeenAt: 0,
        candidateEligible: false, candidateReason: "",
        lastAdoptedUrl: "", lastAdoptedTitle: "", lastAdoptedAt: 0, lastAdoptionMode: ""
      },
      recovery: {
        stage: "idle", reason: "", attempts: 0, softReloads: 0, tabRecreates: 0, browserRestarts: 0,
        lastAttemptAt: 0, nextCheckAt: 0, cooldownUntil: 0, lastRecoveredAt: 0, alerted: false, lastError: ""
      },
      checkpoint: {
        revision: 0, fingerprint: "", planVersion: "", goal: "", completed: [], currentTask: "", decisions: [],
        evidence: [], blockers: [], nextAction: "", doNotRepeat: [], stage: "active", githubPr: 0,
        sourceTurnId: "", updatedAt: 0, completionStatus: "missing",
        evidenceHealth: { configured: false, ok: false, checkedAt: 0, reasons: [], localGit: null, github: null }
      },
      updatedAt: 0
    };
  }

  read(projectId) {
    if (!this.projects.has(projectId)) throw new Error("unknown_project");
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(projectId), "utf8"));
      return { ...this.empty(projectId), ...parsed,
        control: { ...this.empty(projectId).control, ...(parsed.control || {}) },
        runtime: { ...this.empty(projectId).runtime, ...(parsed.runtime || {}) },
        discovery: { ...this.empty(projectId).discovery, ...(parsed.discovery || {}) },
        recovery: { ...this.empty(projectId).recovery, ...(parsed.recovery || {}) },
        checkpoint: { ...this.empty(projectId).checkpoint, ...(parsed.checkpoint || {}),
          evidenceHealth: { ...this.empty(projectId).checkpoint.evidenceHealth, ...(parsed.checkpoint?.evidenceHealth || {}) }
        }
      };
    } catch (error) {
      if (error?.code === "ENOENT") return this.empty(projectId);
      throw error;
    }
  }

  write(projectId, value) {
    const file = this.file(projectId);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return value;
  }

  patch(projectId, section, patch) {
    const current = this.read(projectId);
    const next = { ...current, [section]: { ...current[section], ...patch }, updatedAt: this.now() };
    return this.write(projectId, next);
  }

  setPaused(projectId, paused) {
    return this.patch(projectId, "control", { paused: Boolean(paused) });
  }

  bump(projectId, field) {
    const current = this.read(projectId);
    const next = Number(current.control[field] || 0) + 1;
    return this.patch(projectId, "control", { [field]: next });
  }

  observe(projectId, detail = {}) {
    const current = this.read(projectId);
    const key = String(detail.progressKey || "").slice(0, 512);
    const changed = Boolean(key) && key !== current.runtime.progressKey;
    const at = this.now();
    const runtime = {
      ...current.runtime,
      lastSeenAt: at,
      lastProgressAt: (!current.runtime.lastProgressAt || changed) ? at : current.runtime.lastProgressAt,
      progressKey: key || current.runtime.progressKey,
      status: String(detail.status || current.runtime.status || "unknown").slice(0, 64),
      lastTurnRole: String(detail.lastTurnRole || current.runtime.lastTurnRole || "").slice(0, 32),
      lastTurnId: String(detail.lastTurnId || current.runtime.lastTurnId || "").slice(0, 256),
      latestAssistantExcerpt: String(detail.latestAssistantExcerpt || current.runtime.latestAssistantExcerpt || "").slice(-3000),
      latestUserExcerpt: String(detail.latestUserExcerpt || current.runtime.latestUserExcerpt || "").slice(-2000)
    };
    if (!changed && at - Number(current.updatedAt || 0) < 15000) return { state: current, changed };
    return { state: this.write(projectId, { ...current, runtime, updatedAt: at }), changed };
  }

  recordDiscovery(projectId, candidate = null, meta = {}) {
    const at = this.now();
    return this.patch(projectId, "discovery", {
      lastScanAt: at,
      candidateUrl: String(candidate?.url || "").slice(0, 2048),
      candidateTitle: String(candidate?.title || "").slice(0, 300),
      candidatePreview: String(candidate?.preview || "").slice(0, 800),
      candidateSeenAt: candidate?.url ? at : 0,
      candidateEligible: Boolean(candidate?.url && meta.eligible),
      candidateReason: String(meta.reason || "").slice(0, 64)
    });
  }

  recordAdoption(projectId, { url, title = "", mode = "manual" } = {}) {
    const at = this.now();
    return this.patch(projectId, "discovery", {
      lastAdoptedUrl: String(url || "").slice(0, 2048),
      lastAdoptedTitle: String(title || "").slice(0, 300),
      lastAdoptedAt: at,
      lastAdoptionMode: String(mode || "manual").slice(0, 32),
      candidateUrl: "", candidateTitle: "", candidatePreview: "", candidateSeenAt: 0,
      candidateEligible: false, candidateReason: ""
    });
  }

  recordRecovery(projectId, patch = {}) {
    const current = this.read(projectId);
    const recovery = { ...current.recovery, ...patch };
    return this.write(projectId, { ...current, recovery, updatedAt: this.now() });
  }

  clearRecovery(projectId) {
    const current = this.read(projectId);
    return this.write(projectId, {
      ...current,
      recovery: { ...this.empty(projectId).recovery, lastRecoveredAt: this.now() },
      updatedAt: this.now()
    });
  }


  recordCheckpoint(projectId, checkpoint, { fingerprint, sourceTurnId = "", completionStatus = "active", evidenceHealth = null } = {}) {
    const current = this.read(projectId);
    if (!fingerprint || fingerprint === current.checkpoint.fingerprint) return { state: current, changed: false };
    const at = this.now();
    const nextCheckpoint = {
      ...current.checkpoint, ...checkpoint, fingerprint: String(fingerprint).slice(0, 64),
      revision: Number(current.checkpoint.revision || 0) + 1, sourceTurnId: String(sourceTurnId || "").slice(0, 256),
      updatedAt: at, completionStatus: String(completionStatus || "active").slice(0, 64),
      evidenceHealth: evidenceHealth ? { ...current.checkpoint.evidenceHealth, ...evidenceHealth } : current.checkpoint.evidenceHealth
    };
    const state = this.write(projectId, { ...current, checkpoint: nextCheckpoint, updatedAt: at });
    return { state, changed: true };
  }

  updateCheckpointEvidence(projectId, evidenceHealth, completionStatus) {
    const current = this.read(projectId);
    if (!current.checkpoint.fingerprint) return { state: current, changed: false };
    const at = this.now();
    const next = {
      ...current,
      checkpoint: {
        ...current.checkpoint, completionStatus: String(completionStatus || current.checkpoint.completionStatus).slice(0, 64),
        evidenceHealth: { ...current.checkpoint.evidenceHealth, ...(evidenceHealth || {}) }
      },
      updatedAt: at
    };
    return { state: this.write(projectId, next), changed: true };
  }

  control(projectId) { return this.read(projectId).control; }
  snapshot(projectId) { return this.read(projectId); }
  all() { return [...this.projects].map((id) => this.read(id)); }
}
