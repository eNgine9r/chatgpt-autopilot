(() => {
  "use strict";

  function isLeaseStale({ leaseAtMs, nowMs, ttlMs }) {
    const at = Number(leaseAtMs || 0);
    const now = Number(nowMs || 0);
    const ttl = Number(ttlMs || 0);
    if (!at || !now || ttl <= 0) return true;
    if (at > now) return false;
    return now - at > ttl;
  }

  globalThis.AutopilotLeasePolicy = Object.freeze({ isLeaseStale });
})();