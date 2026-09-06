(() => {
  const DEFAULT_MIN_GAP_MS = 90000;
  const DEFAULT_RATE_LIMIT_BACKOFF_MS = 900000;

  function canStartNavigation({ paused = false, forced = false, now = Date.now(), lastNavigationAt = 0,
    backoffUntil = 0, minGapMs = DEFAULT_MIN_GAP_MS } = {}) {
    if (Number(backoffUntil || 0) > Number(now)) return false;
    if (Number(lastNavigationAt || 0) > 0 && Number(now) - Number(lastNavigationAt) < Number(minGapMs)) return false;
    return Boolean(forced || !paused);
  }

  function nextRateLimitBackoff({ now = Date.now(), currentBackoffUntil = 0,
    durationMs = DEFAULT_RATE_LIMIT_BACKOFF_MS } = {}) {
    return Math.max(Number(currentBackoffUntil || 0), Number(now) + Number(durationMs));
  }

  globalThis.AutopilotNavigationPressurePolicy = Object.freeze({
    DEFAULT_MIN_GAP_MS,
    DEFAULT_RATE_LIMIT_BACKOFF_MS,
    canStartNavigation,
    nextRateLimitBackoff
  });
})();
