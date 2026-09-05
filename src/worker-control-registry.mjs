import { isOperatorProjectProvenIdle } from "./operator-control.mjs";
import fs from "node:fs";

const WORKER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

function emptyState(status = "worker_offline") {
  return {
    control: { paused: false, restartGeneration: 0, rolloverGeneration: 0, adoptGeneration: 0, discoveryScanGeneration: 0 },
    runtime: { lastSeenAt: 0, lastProgressAt: 0, progressKey: "", status },
    checkpoint: { revision: 0, completionStatus: "missing", blockers: [], evidenceHealth: { configured: false, ok: false, reasons: [] } },
    recovery: { stage: "idle", attempts: 0, lastError: "" },
    mirrorSync: { lastProbeAt: 0, lastResult: "never", lastRefreshAt: 0, lastError: "" }
  };
}

function normalizeWorker(raw) {
  const id = String(raw?.id || "");
  if (!WORKER_ID.test(id)) throw new Error("invalid_worker_id");
  const url = new URL(String(raw?.baseUrl || ""));
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/") {
    throw new Error(`${id}: worker baseUrl must be loopback http origin`);
  }
  const projects = Array.isArray(raw?.projects) ? raw.projects.map((project) => {
    const projectId = String(project?.id || "");
    if (!PROJECT_ID.test(projectId)) throw new Error(`${id}: invalid_project_id`);
    return { id: projectId, name: String(project?.name || projectId).slice(0, 160) };
  }) : [];
  if (!projects.length) throw new Error(`${id}: worker requires projects`);
  const restartServices = Array.isArray(raw?.restartServices)
    ? raw.restartServices.map((value) => String(value || "")).filter(Boolean)
    : [];
  return { id, name: String(raw?.name || id).slice(0, 160), baseUrl: url.origin, projects, restartServices };
}

export function loadWorkerRegistry(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const workers = Array.isArray(parsed?.workers) ? parsed.workers.map(normalizeWorker) : [];
  if (!workers.length) throw new Error("worker_registry_empty");
  const workerIds = new Set(); const projectIds = new Set();
  for (const worker of workers) {
    if (workerIds.has(worker.id)) throw new Error(`duplicate_worker:${worker.id}`);
    workerIds.add(worker.id);
    for (const project of worker.projects) {
      if (projectIds.has(project.id)) throw new Error(`duplicate_project:${project.id}`);
      projectIds.add(project.id);
    }
  }
  return workers;
}
async function fetchJson(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(String(body.error || `HTTP_${response.status}`));
      error.status = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function offlineProject(worker, project, error) {
  return {
    id: project.id, name: project.name, chatUrl: "", planVersion: "",
    chatDiscovery: { enabled: false, autoAdopt: false },
    browserRecovery: { enabled: false, allowSessionRestart: false },
    checkpointLedger: { enabled: false, evidenceConfigured: false },
    state: emptyState(), watchdog: null,
    worker: { id: worker.id, name: worker.name, online: false, error: String(error || "worker_unavailable").slice(0, 300) }
  };
}
export class WorkerControlRegistry {
  constructor({
    workers, fetchImpl = fetch, timeoutMs = 3000, restartWorker = null,
    now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    restartBarrierTimeoutMs = 30000, restartBarrierPollMs = 500
  }) {
    this.workers = workers.map(normalizeWorker);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.restartWorker = restartWorker;
    this.now = now;
    this.sleep = sleep;
    this.restartBarrierTimeoutMs = restartBarrierTimeoutMs;
    this.restartBarrierPollMs = restartBarrierPollMs;
    this.projectWorker = new Map();
    for (const worker of this.workers) for (const project of worker.projects) {
      if (this.projectWorker.has(project.id)) throw new Error(`duplicate_project:${project.id}`);
      this.projectWorker.set(project.id, worker);
    }
  }

  async workerStatus(worker) {
    try {
      const body = await fetchJson(this.fetchImpl, `${worker.baseUrl}/operator/status`, {}, this.timeoutMs);
      const returned = new Map((body.projects || []).map((project) => [project.id, project]));
      const projects = worker.projects.map((expected) => {
        const project = returned.get(expected.id);
        if (!project) return offlineProject(worker, expected, "project_missing_from_worker");
        return { ...project, worker: { id: worker.id, name: worker.name, online: true, error: "" } };
      });
      return { id: worker.id, name: worker.name, online: true, error: "", projects };
    } catch (error) {
      return { id: worker.id, name: worker.name, online: false, error: String(error?.message || error).slice(0, 300), projects: worker.projects.map((project) => offlineProject(worker, project, error?.message)) };
    }
  }
  async status() {
    const workers = await Promise.all(this.workers.map((worker) => this.workerStatus(worker)));
    return {
      ok: true,
      generatedAt: this.now(),
      workers: workers.map(({ projects, ...worker }) => worker),
      projects: workers.flatMap((worker) => worker.projects)
    };
  }

  async action(projectId, action) {
    const worker = this.projectWorker.get(String(projectId || ""));
    if (!worker) {
      const error = new Error("unknown_project"); error.status = 404; throw error;
    }
    return fetchJson(this.fetchImpl, `${worker.baseUrl}/operator/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, action })
    }, this.timeoutMs);
  }

  async restartAll() {
    if (!this.restartWorker) {
      const error = new Error("worker_restart_unavailable"); error.status = 503; throw error;
    }
    const initial = await this.status();
    const unsafe = initial.projects.filter((project) => !this.isProvenIdle(project));
    if (unsafe.length) {
      const error = new Error(`restart_blocked:${unsafe.map((project) => project.id).join(",")}`);
      error.status = 409; throw error;
    }

    // Freeze every project before restarting any worker. The first idle snapshot is
    // not enough: a continuation could start in the gap between status() and
    // systemctl restart. A fresh post-pause idle heartbeat closes that TOCTOU race.
    const beforeSeen = new Map(initial.projects.map((project) => [
      project.id, Number(project.state?.runtime?.lastSeenAt || 0)
    ]));
    const pausedByHub = initial.projects
      .filter((project) => project.state?.control?.paused !== true)
      .map((project) => project.id);
    for (const projectId of pausedByHub) await this.action(projectId, "pause");

    const deadline = this.now() + this.restartBarrierTimeoutMs;
    let blocked = [];
    while (true) {
      const frozen = await this.status();
      blocked = frozen.projects.filter((project) => {
        const seen = Number(project.state?.runtime?.lastSeenAt || 0);
        return project.state?.control?.paused !== true
          || seen <= Number(beforeSeen.get(project.id) || 0)
          || !this.isProvenIdle(project);
      });
      if (!blocked.length) break;
      if (this.now() >= deadline) {
        const error = new Error(`restart_barrier_failed:${blocked.map((project) => project.id).join(",")}`);
        error.status = 409;
        throw error;
      }
      await this.sleep(this.restartBarrierPollMs);
    }

    for (const worker of this.workers) await this.restartWorker(worker);
    return {
      ok: true,
      restarting: this.workers.map((worker) => worker.id),
      pausedProjects: pausedByHub,
      projectsRemainPaused: true
    };
  }
  isProvenIdle(project) {
    return isOperatorProjectProvenIdle(project, this.now());
  }
}
