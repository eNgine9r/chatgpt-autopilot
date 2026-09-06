(() => {
  function composeHandoff({ preamble = "", handoff = "" } = {}) {
    const boundedPreamble = String(preamble || "").slice(0, 15000);
    const boundedHandoff = String(handoff || "").slice(-4500);
    return `${boundedPreamble}\n\n=== BOUNDED CHAT TAIL ===\n${boundedHandoff}\n=== END CHAT TAIL ===`.slice(0, 20000);
  }

  function serialProcessor(task) {
    let tail = Promise.resolve();
    return (...args) => {
      const run = tail.catch(() => {}).then(() => task(...args));
      tail = run;
      return run;
    };
  }

  globalThis.AutopilotRolloverPolicy = Object.freeze({ composeHandoff, serialProcessor });
})();