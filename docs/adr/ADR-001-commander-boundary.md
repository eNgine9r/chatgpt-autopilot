# ADR-001: Commander bounded context

- Status: Accepted
- Date: 2026-09-09
- Tracking issue: #182
- Audited baseline: `c5b0a8938840c66a7222c8a05a1d5c07ad5007a5`

## Context

Autopilot v3 is already a deterministic, event-driven orchestrator with durable state, explicit approval states, a narrow deterministic executor, a restricted SSH gateway, GitHub webhook ingress, Telegram operator surfaces and fault-isolated browser/Codex fallbacks.

We need a self-hosted replacement for the engineering capabilities currently obtained through Remote Desktop Commander, while continuing normal Autopilot development in parallel and without turning the existing v3 restricted SSH transport into an uncontrolled general shell.

## Decision

Commander will be implemented as an **independent bounded execution/control-plane context inside the existing `eNgine9r/chatgpt-autopilot` repository**.

Autopilot v3 remains the deterministic workflow orchestrator and durable project-state owner.

Commander owns:

- managed-device identity and sessions;
- capability advertisement;
- device routing;
- execution lifecycle;
- filesystem/process/service/Git infrastructure operations;
- Commander authorization/policy;
- operation audit/evidence.

Autopilot v3 talks to Commander only through a versioned `CommanderClient`/public contract. It does not import Agent or Gateway internals.

External MCP integration is a thin adapter over the same Commander public boundary. Commander Core does not depend on ChatGPT/MCP.

## Repository decision

Use incremental directories under the existing repository, centered on `src/commander/`, plus explicit tests/scripts/systemd templates.

Do **not** convert the repository into a new monorepo layout merely to introduce Commander. Existing v3/browser/Browserless/Codex files remain in place unless a later focused refactor has independent value.

## Existing SSH gateway

The current `ssh-gateway` + `scripts/v3-remote-gateway.py` remains intact for its current fixed repository operations.

It will not be expanded in-place into an arbitrary remote shell. Commander gets its own contracts, identity, transport, policy and audit boundaries.

This protects the security assumptions already documented by the repository.

## Governance constraint

Current `AGENTS.md` explicitly limits remote SSH to the Codex/forced-command model and prohibits adding general production-control capabilities without a future explicitly scoped Issue.

Therefore:

1. this ADR authorizes the **architectural boundary**, not general shell or production authority;
2. Phase 0 makes no change to `AGENTS.md`;
3. before Phase 5 enables new mutating remote capabilities, the implementing issue/PR must explicitly review and update repository governance as required;
4. ADMIN capabilities need separate explicit authorization and remain disabled by default;
5. trading, exchange, Modbus/hardware and product deployment permissions remain outside Commander infrastructure authority unless separately scoped.

## Device and transport decision

MVP is Linux-first, targeting the user-owned Raspberry Pi/Linux environments.

Managed-device identity is stable and independent of IP address. Private authenticated connectivity is required; Tailscale/private networking is preferred. Devices must not expose an arbitrary command listener directly to the public Internet.

The exact session authentication/transport protocol is intentionally deferred to Phase 1/2 and must be documented before live enablement.

## State ownership

Commander state is logically separate from Autopilot v3 project state.

Autopilot persists workflow/project state. Commander persists only the execution/device/audit state required for its own responsibilities and returns structured results to Autopilot.

Neither component may directly mutate the other's private state files.

## Capability decision

Commander is deny-by-default with independent READ, WRITE and ADMIN capabilities.

Typed operations are preferred to arbitrary shell strings. If a shell escape hatch is later necessary, it must be explicit, policy-controlled, audited and must not become the default API.

All operations require bounded time/output/concurrency. Mutating operations require idempotency semantics where retry could otherwise duplicate effects.

## Deployment decision

Commander is additive until proven:

1. implementation disabled by default;
2. shadow/read-only validation;
3. NexoLab pilot;
4. BTC Radar pilot;
5. explicit Commander-primary cutover;
6. Remote Desktop Commander remains fallback until a separate decommission decision.

No merge or service installation implicitly performs production cutover.

## Consequences

### Positive

- current Autopilot v3 development remains independent;
- no second orchestrator/state machine is introduced;
- Commander can be tested and released independently;
- the same execution plane can serve Autopilot and MCP clients;
- current restricted SSH safety is preserved during migration;
- rollout and rollback can occur one device/project at a time.

### Costs

- a public contract layer and compatibility tests are required;
- Agent/Gateway version compatibility must be managed;
- some capabilities already possible through generic remote shell require deliberate typed APIs/policy work;
- temporary duplication exists while Remote Desktop Commander and existing v3 SSH transport remain fallbacks.

## Alternatives rejected

### Separate Commander repository

Rejected for now because deployment, CI, contracts and Autopilot integration would require unnecessary cross-repository coordination. The bounded context inside the same repository provides isolation without operational fragmentation.

### Rewrite Autopilot around Commander

Rejected. v3 already supplies deterministic orchestration, durable state, approvals and event handling. Replacing it would create regression risk and block ongoing work.

### One monolithic Autopilot/Commander service

Rejected because process/device failures could take down orchestration and would make security boundaries unclear.

### Expand `v3-remote-gateway.py` into a generic shell

Rejected because it would violate the current least-privilege forced-command model and mix two distinct trust boundaries.

### Fork all Remote Desktop Commander functionality immediately

Rejected for MVP. We need the engineering capabilities actually used by our workflow, not GUI/SaaS/billing/general cross-platform parity. Any reuse of third-party open-source code requires a later focused license/security audit.

## Validation

This decision is considered valid if Phase 1 can define Commander contracts without changing Autopilot v3 internals and if future Commander services can be disabled/absent while the current v3 test/runtime behavior remains unchanged.