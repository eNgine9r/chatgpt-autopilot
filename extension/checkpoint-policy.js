(() => {
  const START = "[[AUTOPILOT_CHECKPOINT]]";
  const END = "[[/AUTOPILOT_CHECKPOINT]]";

  function parse(text) {
    const value = String(text || "");
    const start = value.lastIndexOf(START);
    if (start < 0) return null;
    const end = value.indexOf(END, start + START.length);
    if (end < 0) return null;
    const raw = value.slice(start + START.length, end).trim();
    if (!raw || raw.length > 12000) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function strip(text) {
    let value = String(text || "");
    for (let i = 0; i < 20; i += 1) {
      const start = value.indexOf(START);
      if (start < 0) break;
      const end = value.indexOf(END, start + START.length);
      if (end < 0) break;
      value = `${value.slice(0, start)}${value.slice(end + END.length)}`;
    }
    return value.replace(/\n{3,}/g, "\n\n").trim();
  }

  globalThis.AutopilotCheckpointPolicy = Object.freeze({ parse, strip, START, END });
})();