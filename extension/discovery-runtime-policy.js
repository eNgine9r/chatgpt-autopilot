(function attachDiscoveryRuntimePolicy(global) {
  const GATES = new Set([
    "idle", "pending", "no_source_tab", "source_status_unavailable", "rate_limited",
    "generation_active", "policy_wait", "navigation_denied", "started", "finalized", "timeout",
    "pending_tab_missing", "root_not_ready", "scan_message_unavailable", "candidate_wait"
  ]);

  function boundedInt(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  function state(value = {}) {
    const gate = String(value.gate || "idle");
    return {
      gate: GATES.has(gate) ? gate : "idle",
      controlGeneration: boundedInt(value.controlGeneration),
      scanGeneration: boundedInt(value.scanGeneration),
      pending: Boolean(value.pending),
      updatedAt: boundedInt(value.updatedAt)
    };
  }

  function snapshot(value = {}) {
    const current = state(value);
    return {
      discoverySchedulerGate: current.gate,
      discoverySchedulerControlGeneration: current.controlGeneration,
      discoverySchedulerScanGeneration: current.scanGeneration,
      discoverySchedulerPending: current.pending,
      discoverySchedulerUpdatedAt: current.updatedAt
    };
  }

  global.AutopilotDiscoveryRuntimePolicy = { state, snapshot };
})(globalThis);
