(() => {
  function shouldStartScan({ enabled, pending, generating, paused, forced, due }) {
    if (!enabled || pending || generating) return false;
    return Boolean(forced || (due && !paused));
  }

  function shouldAdopt({ mode, generating, paused, candidate }) {
    if (!candidate || generating) return false;
    if (mode === "auto") return !paused;
    return mode === "manual";
  }

  function scanDisposition({ timedOut = false, currentChatUrl = "", candidateUrls = [] }) {
    if (timedOut) return "timeout";
    const current = String(currentChatUrl || "");
    const hasAlternative = candidateUrls.some((url) => String(url || "") && String(url) !== current);
    return hasAlternative ? "finalize" : "wait";
  }

  function durableCandidate(discovery = {}) {
    return {
      url: String(discovery.candidateUrl || ""),
      title: String(discovery.candidateTitle || ""),
      preview: String(discovery.candidatePreview || "")
    };
  }

  globalThis.AutopilotDiscoveryPolicy = Object.freeze({ shouldStartScan, shouldAdopt, scanDisposition, durableCandidate });
})();
