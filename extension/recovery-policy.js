(() => {
  function mayMutateTab({ generatingKnown, generating, authBlocked, rateLimited, safetyBlocked }) {
    return Boolean(generatingKnown && !generating && !authBlocked && !rateLimited && !safetyBlocked);
  }

  function nextStage({ stage = "idle", tabPresent, canMutate }) {
    if (!canMutate && tabPresent) return "blocked";
    if (stage === "idle") return tabPresent ? "soft_reload" : "tab_recreate";
    if (stage === "soft_reload") return "tab_recreate";
    if (stage === "tab_recreate") return "escalate";
    if (stage === "browser_restart") return "escalate";
    return "escalate";
  }

  function shouldRestartBrowser({ unhealthyCount, enabledCount, activeGenerationCount, unknownGenerationCount = 0 }) {
    return enabledCount > 0 && unhealthyCount >= enabledCount && activeGenerationCount === 0 && unknownGenerationCount === 0;
  }

  globalThis.AutopilotRecoveryPolicy = Object.freeze({ mayMutateTab, nextStage, shouldRestartBrowser });
})();
