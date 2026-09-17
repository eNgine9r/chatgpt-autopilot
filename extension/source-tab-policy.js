(function (root) {
  async function firstResponsive({ tabs = [], target = "", normalize, probe } = {}) {
    if (typeof normalize !== "function" || typeof probe !== "function") return null;
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id)) continue;
      if (normalize(tab.url || "") !== target) continue;
      const status = await probe(tab.id);
      if (status) return { tab, status };
    }
    return null;
  }

  root.AutopilotSourceTabPolicy = Object.freeze({ firstResponsive });
})(globalThis);
