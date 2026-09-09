# Commander architecture overview

Status: Phase 0 architecture baseline
Baseline date: 2026-09-09
Audited `main` SHA: `c5b0a8938840c66a7222c8a05a1d5c07ad5007a5`
Tracking issue: #182

## Purpose

Commander is an additive execution/control-plane bounded context inside `eNgine9r/chatgpt-autopilot`. It provides secure, structured access to user-owned Linux hosts while Autopilot v3 remains the deterministic workflow orchestrator and durable workflow-state owner.

Commander does **not** replace Autopilot v3, create a second scheduler, or change current production behavior during Phase 0.

## Audited current architecture

The repository already contains the foundations that Commander must integrate with rather than duplicate:

| Area | Current implementation | Commander relationship |
| --- | --- | --- |
| Deterministic orchestration | `src/v3/state-machine.mjs`, `orchestrator.mjs`, `execution-engine.mjs` | Remains authoritative workflow control plane |
| Safe execution | `src/v3/executor.mjs` | Remains current executor/fallback until explicit migration |
| Remote project transport | `transport.type: ssh-gateway` + `scripts/v3-remote-gateway.py` | Keep unchanged; Commander is a broader future execution plane, not an in-place expansion of this forced command |
| Durable v3 state | `src/v3/store.mjs`, local `state-v3` | Commander state is logically separate; v3 consumes only public Commander results |
| GitHub ingress | dedicated HMAC listener, default loopback `8781` | No Commander coupling required |
| Telegram | separate v3 bridge | Operator surface may later display Commander state, but tokens stay outside Commander Core |
| Mini App | separate v3 Mini App service | No Phase 0 change |
| Browser/Codex/Browserless | fault-isolated existing backends | Continue independently; Commander must not make Chromium critical-path again |
| Deployment | user-systemd templates/installers | Future Commander Agent/Gateway use separate staged units |
| CI | one repository-wide `quality` job | Phase 0 documents a future path-scoped Commander pipeline; current CI stays authoritative |

Current v3 execution is deliberately narrow: `repo.inspect`, `repo.test`, and `operator.review`. Remote v3 execution uses a dedicated forced SSH command, bounded output/time, sanitized environment, and fixed operations. This is a useful security pattern, but it is not a general remote-management API.

## Observed production snapshot

Read-only inspection on 2026-09-09 observed `btc-radar` running:

- `chatgpt-autopilot-v3.service` -> `src/v3/index.mjs`;
- `chatgpt-autopilot-v3-miniapp.service` -> `src/v3/miniapp-service.mjs`;
- Tailscale Funnel paths for `/autopilot`, `/autopilot-events`, and `/autopilot-v3-github`;
- the runtime checkout on an active work branch rather than `main`.

Phase 0 therefore uses its own GitHub branch/PR and does not modify the production checkout, services, Funnel routes, or local state.

## Required Commander capabilities from actual workflow

Recent Remote Desktop Commander usage shows that the practical replacement target is primarily:

1. start a bounded process/command;
2. stream/read process output;
3. send bounded input and cancel owned processes;
4. read, write and surgically edit project files;
5. list/search files;
6. inspect processes and user-systemd services;
7. perform Git/GitHub-oriented engineering operations through controlled execution;
8. inspect system/runtime health.

The target is functional parity for this engineering workflow, not a clone of every Remote Desktop Commander feature. Browser/GUI control is explicitly outside the Commander MVP.

## Boundary

```text
GitHub / Telegram / Mini App / Browser / Codex
                    |
                    v
             Autopilot v3
      deterministic state + policy
                    |
                    v
          CommanderClient interface
                    |
                    v
            Commander Gateway
        auth / routing / policy / audit
                    |
             private transport
                    |
          +---------+---------+
          |                   |
          v                   v
   Commander Agent      Commander Agent
   nexolab-edge-01         btc-radar
```

An MCP adapter is a peer client of the same Commander public boundary:

```text
MCP client -> MCP adapter -> Commander public API -> Gateway -> Agent
Autopilot v3 -----------> CommanderClient ---------> Gateway -> Agent
```

Commander Core must not depend on ChatGPT or MCP.

## Dependency rule

Allowed:

```text
src/v3 -> CommanderClient/public contracts -> Commander Gateway
MCP adapter -> Commander public contracts/client
Gateway -> Agent protocol
```

Forbidden:

```text
src/v3 -> Agent internals
src/v3 -> Gateway internals
Agent -> Autopilot state files
Commander -> browser/Codex private state
```

Autopilot receives structured operation results and evidence. It must not determine Commander state by scraping logs.

## Minimum-invasive repository placement

The repository is currently a compact Node/Python codebase, not an apps/services/packages monorepo. Phase 0 therefore rejects a repository-wide structural rewrite.

Recommended incremental placement:

```text
src/
  commander/
    contracts/
    client/
    gateway/
    agent/
  integrations/
    mcp/
      commander/

test/
  commander-*.test.mjs

scripts/
  commander-*.sh|mjs|py

systemd/
  chatgpt-autopilot-commander-*.service.template
```

Exact language/module choices are decided in Phase 1/2 after contract and runtime constraints are tested. Existing `src/v3`, browser, Browserless and Codex paths are not moved merely for aesthetic consistency.

## Public contract boundary

Phase 1 must define versioned contracts for at least:

- `Device`;
- `Capability`;
- `Execution`;
- `ExecutionEvent`;
- `OperationResult`;
- `CommanderError`.

Every request/result must support correlation through request/execution IDs. Mutations additionally require idempotency semantics. Output/time/concurrency are bounded and truncation is explicit.

Initial machine states should include:

`queued`, `running`, `success`, `failed`, `cancelled`, `timeout`, `requires_approval`, `device_offline`.

## Capability model

Commander is deny-by-default and separates authority into three classes:

- **READ**: health, approved file reads/search, process/service status, Git metadata;
- **WRITE**: controlled project-file mutation, owned execution, approved service actions, explicitly approved Git writes;
- **ADMIN**: sudo, reboot, package/system changes.

Product-domain authority is separate. Infrastructure access never implicitly grants trading, exchange, Modbus/hardware, deployment or other product-side authority.

## Feature gates

The implementation must introduce fail-closed gates before capability activation:

```text
COMMANDER_ENABLED=false
COMMANDER_WRITE_ENABLED=false
COMMANDER_ADMIN_ENABLED=false
```

Phase 0 documents these only; it does not alter runtime config.

## Transport direction

Managed devices should use private connectivity and authenticated sessions. Tailscale/private networking is preferred. No arbitrary command listener is to be exposed directly to the public Internet. Stable device identity must not depend on DHCP/Tailscale IP addresses.

The exact device-auth transport (for example mutually authenticated credentials over a persistent channel) is a Phase 1/2 decision and must be captured in a separate ADR before production use.

## Relationship to the existing restricted SSH gateway

The current v3 SSH gateway is intentionally a forced-command interface for fixed repository operations. It remains valid and unchanged during Commander development.

Commander must **not** evolve by quietly turning this forced command into an unrestricted SSH shell. Broader capabilities require their own contract, policy engine, audit model and explicit governance approval.

## Parallel workstreams

Every issue is assigned to one primary track:

- `area/autopilot` — existing orchestration, Mini App, Codex/browser work;
- `area/commander` — Commander contracts, Gateway, Agent and capabilities;
- `area/integration` — explicit cross-boundary work only.

One issue must not silently migrate between tracks. Cross-boundary dependencies are separate issues/PRs.

Existing Autopilot v3 work such as #174 and #175 can continue independently while Commander Phases 1-6 are developed.

## CI isolation strategy

Phase 0 does not modify the existing CI workflow. In an implementation phase, Commander should gain a path-aware job/workflow triggered by changes under paths such as:

- `src/commander/**`;
- `src/integrations/mcp/commander/**`;
- `test/commander-*.test.mjs`;
- `scripts/commander-*`;
- `systemd/*commander*`.

Shared contract/interface changes must run both Commander and relevant Autopilot v3 regression tests. The existing full repository CI remains the merge safety net until path-scoped jobs prove equivalent coverage.

## Migration sequence

```text
Phase 0 architecture only
 -> contracts
 -> Agent registration/heartbeat
 -> read-only capabilities
 -> bounded execution lifecycle
 -> controlled writes
 -> MCP adapter
 -> explicit Autopilot v3 CommanderClient integration
 -> NexoLab shadow pilot
 -> BTC Radar pilot
 -> explicit primary cutover
```

Remote Desktop Commander remains available throughout both pilots and remains fallback after primary cutover until a separate explicit decommission decision.

## Non-goals for MVP

- Windows/macOS support;
- remote GUI/desktop control;
- Chromium/screenshot automation;
- billing/SaaS/multi-tenant product features;
- arbitrary public shell endpoint;
- implicit sudo/root access;
- product trading or hardware control.

## Phase 0 conclusion

The least invasive boundary is to keep Autopilot v3 unchanged as the orchestrator and introduce Commander as an independently testable execution plane behind one public client/API boundary. This preserves current v3 behavior, keeps ongoing Autopilot work unblocked, and gives Commander a controlled migration path with Remote Desktop Commander as fallback.