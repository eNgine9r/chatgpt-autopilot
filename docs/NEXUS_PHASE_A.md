# NEXUS Phase A

NEXUS is the multi-agent evolution of the existing deterministic Autopilot v3 control plane.

Phase A is deliberately **subscription-first** and **zero-default-API-spend**.

## Cost boundary

The default registry enforces:

- `paidApiEnabled = false`
- `dailyApiBudgetUsd = 0`
- `monthlyApiBudgetUsd = 0`
- `maxConcurrentAgents = 1`

A non-zero API budget is rejected while paid APIs are disabled. An API-backed provider cannot be enabled under the zero-spend policy.

## Baseline providers

The registry knows about:

- OpenAI Codex — subscription CLI/runtime path; first real worker candidate via #174.
- Google Gemini — subscription/runtime path pending verification on Omarchy.
- Claude, DeepSeek, Grok and Kimi — represented but disabled in Phase A while only consumer/free access is available.
- Local model — placeholder for a future local runtime.

The registry does **not** automate consumer web chats and does not attempt to bypass account or usage limits.

## Roles

Initial logical roles are:

- orchestrator
- planner
- coder
- reviewer
- tester
- researcher

Roles are capability-based. They are not permanently bound to a single vendor.

## Rollout order

1. Provider registry and fail-closed cost policy.
2. Runtime probes and read-only status.
3. Reuse the bounded Codex worker from #174.
4. Verify a supported Gemini local/subscription path on Omarchy before enabling it.
5. Add further providers individually.
6. Paid APIs remain a later explicit rollout decision.

## Safety

Phase A authorizes no automatic merge, production deployment, trading, Modbus/hardware write, unrestricted shell or production cutover.

See issue #915 for the full acceptance scope.
