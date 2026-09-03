import fs from "node:fs";
import path from "node:path";

function statePath(stateDir, projectId) {
  return path.join(stateDir, `${projectId}.codex.json`);
}

export function loadCodexState(stateDir, projectId) {
  const file = statePath(stateDir, projectId);
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return raw && typeof raw === "object" ? raw : {};
}

export function saveCodexState(stateDir, projectId, state) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = statePath(stateDir, projectId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}
