export class SupervisorProgressWatchdog {
  constructor({ projects, notifier, logger, runtimeStore = null, now = () => Date.now() }) {
    this.projects = new Map(projects.filter((p) => p.enabled).map((p) => [p.id, p]));
    this.notifier = notifier;
    this.logger = logger;
    this.runtimeStore = runtimeStore;
    this.now = now;
    this.startedAt = now();
    this.records = new Map();
  }

  record(projectId) {
    if (!this.records.has(projectId)) {
      this.records.set(projectId, {
        lastSeenAt: 0,
        lastProgressAt: 0,
        progressKey: "",
        alerted: false,
        alertReason: ""
      });
    }
    return this.records.get(projectId);
  }

  observe(projectId, { progressKey = "", status = "" } = {}) {
    const project = this.projects.get(projectId);
    if (!project) return { ok: false, error: "unknown_project" };
    const at = this.now();
    const record = this.record(projectId);
    const key = String(progressKey || "").slice(0, 512);
    const changed = Boolean(key) && key !== record.progressKey;
    record.lastSeenAt = at;
    if (!record.lastProgressAt || changed) {
      record.lastProgressAt = at;
      if (key) record.progressKey = key;
      if (record.alerted && changed) {
        this.logger.info("supervisor_progress_recovered", { project: project.name, status });
        record.alerted = false;
        record.alertReason = "";
      }
    }
    return { ok: true, changed, lastSeenAt: record.lastSeenAt, lastProgressAt: record.lastProgressAt };
  }

  thresholdMs(project) {
    return Number(project.noProgressAlertSeconds || 1800) * 1000;
  }

  async notifyStall(projectId, reason = "no_progress") {
    const project = this.projects.get(projectId);
    if (!project) return { ok: false, delivered: false, error: "unknown_project" };
    if (this.runtimeStore?.control(projectId)?.paused) {
      return { ok: true, delivered: false, suppressed: true, paused: true };
    }
    if (project.watchdogEnabled === false) {
      return { ok: true, delivered: false, suppressed: true, disabled: true };
    }
    const record = this.record(projectId);
    if (record.alerted) return { ok: true, delivered: false, suppressed: true };
    const minutes = Math.max(1, Math.round(this.thresholdMs(project) / 60000));
    const isCodex = project.backend === "codex";
    const detail = reason === "heartbeat_missing"
      ? (isCodex ? "Autopilot не отримує подій від Codex App Server." : "Autopilot не отримує heartbeat від вкладки.")
      : (isCodex ? "Codex не повідомляє про фактичний прогрес." : "У чаті не виявлено фактичного прогресу.");
    const action = isCodex ? "Перевірте Codex worker та журнал Autopilot." : `Перевірте чат вручну.\n${project.chatUrl}`;
    const text = `⚠️ ${project.name}: понад ${minutes} хв немає прогресу.\n${detail}\n${action}`;
    const delivered = await this.notifier.send(text);
    record.alerted = true;
    record.alertReason = reason;
    this.logger.info("supervisor_stall_alert", { project: project.name, reason, delivered, minutes });
    return { ok: true, delivered, suppressed: false };
  }

  snapshot(projectId) {
    const record = this.record(projectId);
    return { ...record, startedAt: this.startedAt };
  }

  async check() {
    const at = this.now();
    for (const [projectId, project] of this.projects) {
      if (project.watchdogEnabled === false || this.runtimeStore?.control(projectId)?.paused) continue;
      const threshold = this.thresholdMs(project);
      const record = this.record(projectId);
      if (!record.lastSeenAt) {
        if (at - this.startedAt >= threshold) await this.notifyStall(projectId, "heartbeat_missing");
        continue;
      }
      if (at - record.lastSeenAt >= threshold) {
        await this.notifyStall(projectId, "heartbeat_missing");
        continue;
      }
      if (record.lastProgressAt && at - record.lastProgressAt >= threshold) {
        await this.notifyStall(projectId, "no_progress");
      }
    }
  }
}
