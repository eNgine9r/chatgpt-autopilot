import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SAFE_SERVICE = /^chatgpt-(?:project-autopilot|autopilot-[a-z0-9_-]+-(?:bridge|browser|worker))\.service$/;

export function validateRestartServices(services) {
  const values = Array.isArray(services) ? services.map((value) => String(value || "")) : [];
  if (!values.length) throw new Error("restart_services_not_configured");
  for (const service of values) {
    if (!SAFE_SERVICE.test(service)) throw new Error(`unsafe_restart_service:${service}`);
  }
  return values;
}

export async function restartWorkerServices(worker, { execFileImpl = execFileAsync } = {}) {
  const services = validateRestartServices(worker?.restartServices);
  for (const service of services) {
    await execFileImpl("systemctl", ["--user", "restart", service], { timeout: 30000, maxBuffer: 1024 * 1024 });
  }
  return { ok: true, workerId: worker.id, services };
}
