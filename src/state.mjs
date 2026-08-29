import fs from "node:fs";
import path from "node:path";

export class StateStore {
  constructor(stateDir) {
    this.file = path.join(stateDir, "runtime-state.json");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return { projects: {} };
    }
  }

  get(projectId) {
    return this.load().projects?.[projectId] || {};
  }

  set(projectId, patch) {
    const state = this.load();
    state.projects ||= {};
    const current = state.projects[projectId] || {};

    const changed = Object.entries(patch).some(([key, value]) => {
      return JSON.stringify(current[key]) !== JSON.stringify(value);
    });
    if (!changed) return current;

    state.projects[projectId] = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return state.projects[projectId];
  }
}
