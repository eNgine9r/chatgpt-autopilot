(() => {
  const DEFAULT_MIN_INTERVAL_MS = 15000;

  function shouldRun({ running = false, lastStartedAt = 0, now = Date.now(), minIntervalMs = DEFAULT_MIN_INTERVAL_MS, force = false } = {}) {
    if (running) return false;
    if (force) return true;
    const last = Number(lastStartedAt || 0);
    const interval = Math.max(1000, Number(minIntervalMs || DEFAULT_MIN_INTERVAL_MS));
    return !last || Number(now) - last >= interval;
  }

  function snapshot(state = {}) {
    return {
      schedulerLastStartedAt: Number(state.lastStartedAt || 0),
      schedulerLastCompletedAt: Number(state.lastCompletedAt || 0),
      schedulerLastSource: String(state.lastSource || ""),
      schedulerRunning: Boolean(state.running),
      schedulerConsecutiveFailures: Number(state.consecutiveFailures || 0)
    };
  }

  globalThis.AutopilotMaintenancePolicy = { DEFAULT_MIN_INTERVAL_MS, shouldRun, snapshot };
})();
