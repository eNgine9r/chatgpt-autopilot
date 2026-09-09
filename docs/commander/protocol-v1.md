# Commander protocol v1

Status: Phase 1 contract foundation
Tracking issue: #183
Protocol name: `commander`
Current version: `1`
Minimum compatible version: `1`

## Purpose

This document defines the first stable public contract shared by future Commander clients, Gateway and Agents. It does not enable a Gateway listener, Agent service or device execution.

Autopilot v3 remains outside this implementation boundary. It will consume this contract later through a `CommanderClient` integration issue.

## Version envelope

Every top-level protocol model carries:

```json
{"protocol":"commander","protocolVersion":1,"minProtocolVersion":1}
```

A peer may advertise a higher current version with a lower compatible floor during negotiation. Version 1 implementations select the highest overlapping version. Normal v1 messages are accepted only when they are encoded as v1; an unsupported message version fails closed.

## Stable identities

`requestId`, `executionId`, `eventId`, `deviceId`, `sessionId` and `idempotencyKey` are bounded opaque identifiers. Device identity is independent of an IP address.

Timestamps are UTC RFC 3339/ISO-8601 values ending in `Z`.

## Core models

### Device

A Linux device advertises stable identity, Agent version and an explicit capability list. Capability advertisements are unique by operation and cannot claim an authority different from the canonical operation registry.

### Capability

A capability is:

```json
{"operation":"file.read","authority":"read","operationVersion":1}
```

The operation registry is protocol vocabulary, **not an authorization grant**. A future policy layer decides what is actually enabled for a device/client.

### OperationRequest

A request carries correlation identity, device, stable operation name and bounded parameters. WRITE and ADMIN operations require an idempotency key at the contract boundary. READ requests may include one but do not require it.

Unknown operation names and unknown top-level fields are rejected.

### Execution

An execution records one bounded operation lifecycle with explicit limits. v1 states are:

- `queued`
- `running`
- `success`
- `failed`
- `cancelled`
- `timeout`
- `requires_approval`
- `device_offline`

A failed execution must include a structured `CommanderError`.

### ExecutionEvent

Events are ordered by a non-negative sequence number and are typed as `state`, `stdout`, `stderr`, or `result`. Event payloads are bounded. Output events carry bounded chunks rather than unbounded process streams.

### OperationResult

A result carries the original request correlation, operation, completion time, optional execution identity, bounded data and optional bounded output metadata.

Successful results cannot contain an error. Failed results must contain one.

Output metadata includes `stdout`, `stderr`, `truncated`, and `totalBytes` so consumers never have to guess whether evidence was clipped.

### CommanderError

Errors contain:

- protocol version envelope;
- stable category;
- stable machine code;
- bounded human message;
- `retryable` flag;
- optional bounded structured details.

Categories in v1 are `validation`, `authentication`, `authorization`, `policy`, `not_found`, `conflict`, `device_offline`, `timeout`, `cancelled`, `transport`, `execution`, `version_mismatch`, and `internal`.

## Operation registry

### READ

`device.health`, `file.read`, `file.list`, `file.info`, `file.search`, `process.list`, `service.status`, `git.status`, `git.diff`, `execution.get`, `execution.output`.

### WRITE

`execution.start`, `execution.input`, `execution.cancel`, `file.write`, `file.move`, `process.terminate`, `service.start`, `service.stop`, `service.restart`, `git.commit`, `git.push`.

### ADMIN

`system.reboot`, `system.package.install`.

These names reserve the public protocol surface. They do not mean the operations are implemented or enabled. Phase 1 implements **zero device actions**.

There is deliberately no `shell.exec` operation. Future arbitrary-shell access, if ever approved, requires a separate explicit contract and security review.

## Bounds

The v1 contract enforces bounded identifiers, request/detail payloads, output, event chunks and execution timeout declarations. Current constants are exported from `src/commander/contracts/constants.mjs` and are part of the v1 compatibility surface.

## Validation rules

The JavaScript validators in `src/commander/contracts/v1.mjs` are the executable v1 reference implementation. External boundaries must validate before routing or execution.

Contract validation is strict:

- unknown fields fail closed;
- unsupported operations fail closed;
- capability authority escalation fails closed;
- unsupported platform/version fails closed;
- oversized data/output fails closed;
- malformed timestamps/identifiers fail closed;
- mutation requests without idempotency identity fail closed.

## Compatibility rule

Changes that only add implementation behind an existing operation do not change the protocol version. A breaking field/state/semantic change requires a new protocol version. New optional fields or new operation names require compatibility review and tests before being accepted into v1.

Gateway and Agent implementations must not silently reinterpret unknown fields or operations.

## Phase boundary

Phase 1 does not provide authentication credentials, network transport, service installation, filesystem access, command execution, Git mutation, sudo, deployment, trading or hardware authority.

Phase 2 may build Agent registration/heartbeat/reconnect against these contracts. Phase 3 begins read-only capabilities only after that lifecycle is proven.
