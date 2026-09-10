# ADR-007 — Autopilot v3 Commander Client Boundary

- Status: Accepted for Phase 7 implementation
- Date: 2026-09-10
- Decision scope: Commander Phase 7 / Issue #189

## Context

Autopilot v3 is the deterministic orchestrator and durable workflow-state owner. Commander is a separate execution plane. Phase 7 must connect them without importing Agent/Gateway internals, without making MCP a dependency, and without silently replacing the existing local/restricted-SSH executor path.

A Commander transport failure is ambiguous for mutating operations: an execution may have started even if the response was lost. A retry must therefore distinguish ambiguous transport failure from a known terminal execution failure.

## Decision

The only integration path is:

```text
Autopilot v3 -> CommanderV3Client -> CommanderPublicClient -> Gateway -> Agent
```

`src/v3` imports the Commander public client/contracts only. It does not import Agent, Gateway server, policy, execution-engine, or MCP internals.

Commander routing is additive. A project keeps its existing local or `ssh-gateway` fallback configuration and may add a strict `commander` block. Commander is selected only when both conditions are true:

1. process environment `COMMANDER_ENABLED=true`;
2. `project.commander.enabled=true`.

If either gate is false, existing v3 behavior is unchanged. If Commander is selected and fails, v3 does **not** silently fall back to SSH/local execution for that in-flight step; it records a deterministic blocked state instead. This avoids duplicate execution and mixed evidence.

## Selected action mapping

Phase 7 maps only current deterministic repository actions:

- `repo.inspect` -> `git.status` + `git.log(limit=1)`;
- `repo.test` -> `execution.start` -> `execution.get` polling -> `execution.output`.

`operator.review` remains a v3-local state-machine action.

The project config maps each v3 test alias to a fixed Commander execution alias. No task/event text becomes a command, executable, shell fragment, or arbitrary argument.

## Durable failure and retry semantics

Commander failures are reduced to bounded metadata stored in v3 durable state:

- backend;
- category;
- code;
- retryable;
- device ID;
- operation;
- whether a new mutation attempt is safe.

Raw socket errors, stack traces and arbitrary transport text are not persisted as Commander failure evidence.

Each step carries a durable `attempt` number. Commander mutation idempotency keys are derived from project + task + step + attempt + operation alias.

- ambiguous transport failure keeps the same attempt, so retry reuses the same idempotency key and cannot duplicate an execution whose response was lost;
- a known terminal/explicitly rejected execution marks the retry as a new attempt and therefore receives a new idempotency key.

## Evidence

Successful Commander actions return bounded JSON evidence derived from validated `OperationResult` data, not scraped logs. Repository inspection records head/branch/tracked cleanliness and Commander request IDs. Test execution records execution ID/state/output truncation metadata and request IDs.

## Safety consequences

- Commander outage moves the current v3 step to durable `blocked`; workflow state remains owned by v3.
- no automatic project migration occurs merely because Commander services are enabled;
- existing local/SSH fallback remains test-covered and available by disabling the project Commander gate;
- no ADMIN operation is introduced;
- Phase 7 does not enable production Commander runtime, mutate target-host policy, or perform pilot cutover.

## Rejected alternatives

### Automatic SSH fallback on Commander error

Rejected because an `execution.start` response can be lost after the remote process starts. Automatic fallback could execute the same test/action twice and mix evidence from two backends.

### Reuse MCP from Autopilot v3

Rejected because MCP is an external adapter, not the Commander trust or client boundary. v3 must remain usable without MCP.

### Replace existing project transport config with Commander

Rejected because it would remove the tested rollback/fallback path and violate the incremental migration requirement.
