import fs from "node:fs";
import path from "node:path";

export function listOwnedGcrPrompterPids({
  procRoot = "/proc",
  uid = typeof process.getuid === "function" ? process.getuid() : 1000
} = {}) {
  const pids = [];
  for (const entry of fs.readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const base = path.join(procRoot, entry.name);
    try {
      const comm = fs.readFileSync(path.join(base, "comm"), "utf8").trim();
      if (comm !== "gcr-prompter") continue;
      const status = fs.readFileSync(path.join(base, "status"), "utf8");
      const match = status.match(/^Uid:\s+(\d+)/m);
      if (!match || Number(match[1]) !== Number(uid)) continue;
      pids.push(pid);
    } catch {
      // Processes can disappear while /proc is being scanned.
    }
  }
  return pids.sort((a, b) => a - b);
}

export function findNewPromptPids(baselinePids, currentPids, handledPids = []) {
  const baseline = new Set(Array.from(baselinePids || [], Number));
  const handled = new Set(Array.from(handledPids || [], Number));
  return (currentPids || [])
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0 && !baseline.has(pid) && !handled.has(pid));
}

export async function watchAndDismissNewGcrPrompters({
  baselinePids = [],
  listPids = () => listOwnedGcrPrompterPids(),
  killProcess = (pid, signal) => process.kill(pid, signal),
  logger = null,
  pollMs = 500,
  timeoutMs = 45000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  shouldStop = () => false
} = {}) {
  const handled = new Set();
  const cancelled = [];
  const timeout = Number(timeoutMs);
  const deadline = Number.isFinite(timeout) && timeout > 0
    ? now() + timeout
    : Number.POSITIVE_INFINITY;

  while (!shouldStop() && now() <= deadline) {
    let currentPids = [];
    try {
      currentPids = listPids();
    } catch (error) {
      logger?.error("keyring_prompt_scan_failed", { error: String(error) });
    }

    for (const pid of findNewPromptPids(baselinePids, currentPids, handled)) {
      handled.add(pid);
      try {
        killProcess(pid, "SIGTERM");
        cancelled.push(pid);
        logger?.info("keyring_prompt_cancelled", { pid });
      } catch (error) {
        if (error?.code !== "ESRCH") {
          logger?.error("keyring_prompt_cancel_failed", { pid, error: String(error) });
        }
      }
    }

    if (shouldStop() || now() >= deadline) break;
    await sleep(Math.max(1, pollMs));
  }
  return cancelled;
}
