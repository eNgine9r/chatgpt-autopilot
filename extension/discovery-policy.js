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

  globalThis.AutopilotDiscoveryPolicy = Object.freeze({ shouldStartScan, shouldAdopt });
})();
