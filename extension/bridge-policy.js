(function (root) {
  function normalizeChatUrl(raw) {
    try {
      const url = new URL(String(raw || ""));
      return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
    } catch { return ""; }
  }
  function canonicalProjectId(segment) {
    const value = String(segment || "");
    const match = value.match(/^(g-p-[a-f0-9]{32})(?:-[^/]+)?$/i);
    return match?.[1] || value;
  }
  function projectIdFromUrl(raw) {
    try {
      const url = new URL(normalizeChatUrl(raw));
      const match = url.pathname.match(/^\/g\/([^/]+)(?:\/(?:project|c\/[^/]+))?$/);
      return match ? canonicalProjectId(match[1]) : "";
    } catch { return ""; }
  }
  function scoreCandidate(candidate, tabUrls = []) {
    const projects = Array.isArray(candidate?.config?.projects) ? candidate.config.projects : [];
    const normalizedTabs = tabUrls.map(normalizeChatUrl).filter(Boolean);
    const tabProjects = normalizedTabs.map(projectIdFromUrl).filter(Boolean);
    let score = 0;
    for (const project of projects) {
      const chat = normalizeChatUrl(project?.chatUrl || "");
      const rootId = projectIdFromUrl(project?.projectRootUrl || project?.chatUrl || "");
      if (chat && normalizedTabs.includes(chat)) score += 100;
      else if (rootId && tabProjects.includes(rootId)) score += 10;
    }
    return score;
  }
  function selectBridge(candidates = [], tabUrls = []) {
    const scored = candidates
      .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate, tabUrls) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || String(a.base).localeCompare(String(b.base)));
    if (!scored.length) return null;
    if (scored.length > 1 && scored[0].score === scored[1].score) return null;
    return scored[0];
  }
  root.AutopilotBridgePolicy = { normalizeChatUrl, projectIdFromUrl, scoreCandidate, selectBridge };
})(globalThis);
