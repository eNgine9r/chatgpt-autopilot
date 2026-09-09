# Commander roadmap

Status: Phase 0 baseline
Date: 2026-09-09
Architecture issue: #182

## Workstream governance

Commander is developed in parallel with existing Autopilot work.

Every issue has one primary area:

- `area/autopilot` — existing Autopilot orchestration/backends/operator surfaces;
- `area/commander` — Commander contracts, Agent, Gateway and capabilities;
- `area/integration` — explicit Autopilot/Commander boundary changes.

Rules:

1. one Issue -> one branch -> one focused Pull Request;
2. an issue must not silently expand into another workstream;
3. cross-workstream requirements become separate linked issues;
4. `main` remains deployable;
5. production enablement/cutover is never implied by merging implementation code;
6. ongoing Autopilot work such as #174 and #175 may proceed independently of Commander development.

## Phase map

```text
#182 Phase 0 Architecture
        |
        v
#183 Contracts
        |
        v
#184 Agent identity / heartbeat / reconnect
        |
        v
#185 Read-only capabilities
        |
        v
#186 Execution lifecycle
        |
        v
#187 Controlled writes
        |
        +--------------------+
        |                    |
        v                    v
#188 MCP adapter        #189 Autopilot v3 integration
                             |
                             v
                       #190 NexoLab pilot
                             |
                             v
                       #191 BTC Radar pilot
                             |
                             v
                       #192 Primary cutover
```

MCP #188 is useful for external AI clients, but Autopilot v3 integration #189 must use the Commander public client/API directly and must not depend on MCP being the internal transport.

## Phase 0 — Architecture baseline

Issue: #182
Area: `area/commander`

Deliverables:

- architecture inventory tied to an exact `main` SHA;
- ADR-001 bounded context;
- security model;
- roadmap/issues;
- workstream labels;
- future path-scoped CI strategy;
- feature-gate plan.

No production/runtime behavior change.

## Phase 1 — Contracts & Protocol Foundation

Issue: #183
Area: `area/commander`
Depends on: #182

Define versioned public contracts:

- Device;
- Capability;
- Execution;
- ExecutionEvent;
- OperationResult;
- CommanderError.

Add validation, compatibility and contract tests. No device execution yet.

## Phase 2 — Agent Registration, Heartbeat & Reconnect

Issue: #184
Area: `area/commander`
Depends on: #183

Implement Linux-first Agent foundation:

- stable device identity;
- authenticated registration/session;
- heartbeat/online/offline state;
- bounded reconnect/backoff;
- graceful shutdown;
- staged disabled user-systemd unit;
- Raspberry Pi resource measurements.

No shell/filesystem actions yet.

## Phase 3 — Read-only Device Capabilities

Issue: #185
Area: `area/commander`
Depends on: #184

Implement deny-by-default READ capabilities:

- health/system information;
- allowlisted file read/list/info/search;
- process listing;
- approved service status;
- Git status/diff/log metadata;
- bounded logs.

Acceptance focuses on path traversal, symlink escape, secret-path denial and explicit truncation.

## Phase 4 — Execution Lifecycle & Streaming Output

Issue: #186
Area: `area/commander`
Depends on: #185

Implement first-class executions:

- start/get/output/input/cancel;
- queued/running/final states;
- output chunking;
- timeout/cancellation;
- disconnect/reconnect semantics;
- concurrency/resource bounds;
- idempotency correlation.

No unrestricted root shell.

## Phase 5 — Controlled Write Capabilities & Policy

Issue: #187
Area: `area/commander`
Depends on: #186

Add narrow WRITE capabilities only behind explicit policy and `COMMANDER_WRITE_ENABLED`.

Possible scope:

- controlled project-file writes/edits;
- approved process actions;
- approved user-service restart;
- protected Git writes.

Repository governance is reconciled by ADR-005 and the Issue #187 `AGENTS.md` carve-out. ADMIN stays disabled. Initial acceptance is disposable/non-production only; production writable paths remain a later rollout decision.

## Phase 6 — MCP Adapter

Issue: #188
Area: `area/commander`
Depends on: public contracts and mature enabled capabilities

Expose Commander through a thin MCP adapter:

```text
MCP -> adapter -> Commander API -> Gateway -> Agent
```

MCP cannot bypass Commander auth/policy and Commander Core remains usable without MCP.

No production endpoint cutover in this phase.

## Phase 7 — Autopilot v3 Commander Client

Issue: #189
Area: `area/integration`
Depends on: #183 plus mature read/execution capabilities

Introduce exactly one integration boundary:

```text
Autopilot v3 -> CommanderClient -> Commander Gateway
```

Requirements:

- no direct Agent/Gateway internals imported into `src/v3`;
- structured results/evidence mapped into v3 state;
- Commander offline/timeout/policy/approval mapped deterministically;
- existing v3 executor/restricted SSH path remains feature-gated fallback;
- `COMMANDER_ENABLED=false` preserves existing behavior.

## Phase 8 — NexoLab Shadow Pilot

Issue: #190
Area: `area/commander`
Depends on: #189 and required capability phases

Pilot order:

1. staged Agent installation;
2. explicit service enablement;
3. registration/heartbeat;
4. shadow READ;
5. reboot acceptance;
6. network-loss/reconnect acceptance;
7. Agent/Gateway restart acceptance;
8. controlled non-production WRITE only if #187 is independently accepted.

Remote Desktop Commander remains primary/fallback. No Modbus/hardware writes or site cutover.

## Phase 9 — BTC Radar Pilot

Issue: #191
Area: `area/commander`
Depends on: #190 PASS

Repeat real-host acceptance on `btc-radar`, including comparison with the Remote Desktop Commander engineering workflow.

Commander infrastructure access must not grant trading/exchange authority. Secrets must not be read/surfaced. Rollback must not depend on Commander itself.

## Phase 10 — Commander Primary Cutover

Issue: #192
Area: `area/integration`
Depends on: #190 PASS, #191 PASS and applicable security/write-policy acceptance

Only this phase may make Commander the primary remote path.

Required:

- explicit operator approval;
- per-device/project routing;
- rollback independent of Commander;
- post-cutover reboot/network/restart acceptance;
- observation evidence;
- Remote Desktop Commander retained as fallback.

Remote Desktop Commander decommission is not automatic. It requires a separate explicit decision after stable operation.

## CI roadmap

Phase 0 keeps current repository-wide CI unchanged.

During implementation, introduce a path-aware Commander pipeline covering at least:

```text
src/commander/**
src/integrations/mcp/commander/**
test/commander-*.test.mjs
scripts/commander-*
systemd/*commander*
```

Contract/shared-interface changes run Commander tests plus relevant v3 regression tests. Full repository CI remains a merge gate until the scoped pipeline is proven equivalent for its paths.

## Release gates

No phase advances merely because its PR merged. Runtime gates are distinct from code gates.

```text
code merged
 -> staged disabled
 -> local tests
 -> shadow/read-only acceptance
 -> real-host restart/reconnect evidence
 -> controlled write evidence
 -> pilot PASS
 -> explicit cutover
```

## Definition of program success

Commander succeeds when Autopilot/AI can reliably and securely perform the engineering operations actually required on the managed Linux hosts without depending on Remote Desktop Commander, while:

- Autopilot v3 remains deterministic and independently deployable;
- unrelated Autopilot development continues without Commander coupling;
- permissions are explicit and auditable;
- production/product-domain safety gates remain intact;
- rollback remains possible at every rollout stage.