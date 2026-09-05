(() => {
  function snapshotKey(snapshot = {}) {
    const finished = snapshot.assistantFinished === true
      ? "finished"
      : (snapshot.assistantFinished === false ? "working" : "unknown");
    return [
      String(snapshot.role || "unknown"),
      String(snapshot.turnId || ""),
      finished,
      String(snapshot.textFingerprint || "")
    ].join("|");
  }

  function shouldStartProbe({ enabled, pending, sourcePresent, sourceFresh, sourceKnown, sourceGenerating, sourceBlocked, sourceTurnId, due }) {
    return Boolean(enabled && !pending && sourcePresent && sourceFresh && sourceKnown && !sourceGenerating && !sourceBlocked && String(sourceTurnId || "") && due);
  }

  function provesNewerTurn(sourceTurnId, snapshot = {}) {
    const source = String(sourceTurnId || "");
    const latest = String(snapshot.turnId || "");
    const ordered = Array.isArray(snapshot.recentTurnIds) ? snapshot.recentTurnIds.map(String) : [];
    if (!source || !latest || source === latest) return false;
    const sourceIndex = ordered.lastIndexOf(source);
    const latestIndex = ordered.lastIndexOf(latest);
    return sourceIndex >= 0 && latestIndex > sourceIndex;
  }

  function probeDisposition({ sourceTurnId = "", snapshot = {}, observedKey = "", observedAt = 0,
    now = Date.now(), settleMs = 30000 }) {
    if (!snapshot.ok || !snapshot.generatingKnown) return { action: "wait", key: "", observedAt: 0 };
    if (snapshot.authBlocked || snapshot.rateLimited || snapshot.safetyBlocked) {
      return { action: "blocked", key: snapshotKey(snapshot), observedAt: Number(observedAt || now) };
    }
    const key = snapshotKey(snapshot);
    if (!snapshot.turnId || String(snapshot.turnId) === String(sourceTurnId || "")) {
      return { action: "same", key, observedAt: Number(observedAt || now) };
    }
    if (!provesNewerTurn(sourceTurnId, snapshot)) {
      return { action: "wait", key, observedAt: key === observedKey ? Number(observedAt || now) : now };
    }
    if (snapshot.generating || snapshot.assistantFinished === false) {
      return { action: "wait", key, observedAt: key === observedKey ? Number(observedAt || now) : now };
    }
    if (snapshot.role !== "assistant" || snapshot.assistantFinished === true) {
      return { action: "refresh", key, observedAt: Number(observedAt || now) };
    }
    const firstObservedAt = key === observedKey ? Number(observedAt || now) : now;
    if (now - firstObservedAt >= settleMs && snapshot.composerPresent) {
      return { action: "refresh", key, observedAt: firstObservedAt };
    }
    return { action: "settle", key, observedAt: firstObservedAt };
  }

  function isProbeTab(entry = {}, tabId) {
    return Number.isInteger(tabId) && Number(entry.tabId) === tabId;
  }

  globalThis.AutopilotMirrorSyncPolicy = Object.freeze({
    snapshotKey,
    shouldStartProbe,
    provesNewerTurn,
    probeDisposition,
    isProbeTab
  });
})();
