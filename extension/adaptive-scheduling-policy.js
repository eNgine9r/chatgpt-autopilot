(() => {
  const MIRROR_BASE_MS = 15 * 60 * 1000;
  const MIRROR_MAX_MS = 120 * 60 * 1000;
  const DISCOVERY_FULL_AUDIT_MS = 30 * 60 * 1000;
  const RECOVERY_COOLDOWNS_MS = Object.freeze([5, 15, 30].map((m) => m * 60 * 1000));

  function mirrorDelayMs({ sameStreak = 0, baseMs = MIRROR_BASE_MS, maxMs = MIRROR_MAX_MS } = {}) {
    const streak = Math.max(0, Math.floor(Number(sameStreak || 0)));
    return Math.min(Number(maxMs), Number(baseMs) * (2 ** streak));
  }

  function nextMirrorAudit({ result = "same", now = Date.now(), sameStreak = 0,
    baseMs = MIRROR_BASE_MS, maxMs = MIRROR_MAX_MS } = {}) {
    const current = Math.max(0, Math.floor(Number(sameStreak || 0)));
    if (result === "refresh" || result === "newer") {
      return { sameStreak: 0, nextAuditAt: Number(now) + Number(baseMs) };
    }
    const nextStreak = Math.min(current + 1, 16);
    return {
      sameStreak: nextStreak,
      nextAuditAt: Number(now) + mirrorDelayMs({ sameStreak: nextStreak, baseMs, maxMs })
    };
  }

  function initialMirrorAuditAt({ monitorStartedAt = 0, lastProbeAt = 0, nextAuditAt = 0,
    baseMs = MIRROR_BASE_MS } = {}) {
    if (Number(nextAuditAt || 0) > 0) return Number(nextAuditAt);
    if (Number(lastProbeAt || 0) > 0) return Number(lastProbeAt) + Number(baseMs);
    return Number(monitorStartedAt || Date.now()) + Number(baseMs);
  }

  function shouldUseFullDiscovery({ forced = false, inPlaceConclusive = false, now = Date.now(),
    lastFullScanAt = 0, fullAuditMs = DISCOVERY_FULL_AUDIT_MS } = {}) {
    if (forced) return true;
    if (inPlaceConclusive) return false;
    return Number(now) - Number(lastFullScanAt || 0) >= Number(fullAuditMs);
  }

  function recoveryCooldownMs({ failures = 1, schedule = RECOVERY_COOLDOWNS_MS } = {}) {
    const list = Array.isArray(schedule) && schedule.length ? schedule : RECOVERY_COOLDOWNS_MS;
    const index = Math.min(Math.max(1, Math.floor(Number(failures || 1))) - 1, list.length - 1);
    return Number(list[index]);
  }

  globalThis.AutopilotAdaptiveSchedulingPolicy = Object.freeze({
    MIRROR_BASE_MS,
    MIRROR_MAX_MS,
    DISCOVERY_FULL_AUDIT_MS,
    RECOVERY_COOLDOWNS_MS,
    mirrorDelayMs,
    nextMirrorAudit,
    initialMirrorAuditAt,
    shouldUseFullDiscovery,
    recoveryCooldownMs
  });
})();
