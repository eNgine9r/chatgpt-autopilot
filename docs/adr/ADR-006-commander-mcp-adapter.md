# ADR-006 — Commander MCP Adapter Boundary

- Status: Accepted for Phase 6 implementation
- Date: 2026-09-10
- Decision scope: Commander Phase 6 / Issue #188

## Context

Commander needs an MCP-facing integration without making MCP, ChatGPT, a browser, or a public network endpoint part of Commander Core. ADR-001 already defines the allowed dependency direction as `MCP adapter -> Commander public contracts/client -> Gateway -> Agent` and forbids integrations from reaching Agent internals directly.

Phase 6 must preserve the existing Commander authentication, capability, policy, approval, idempotency, timeout and output-boundary decisions. Remote Desktop Commander remains an independent fallback and no production cutover is authorized by this ADR.

## Decision

Introduce two boundaries:

```text
MCP client
  -> local stdio MCP adapter
  -> CommanderPublicClient
  -> private Unix-domain control socket
  -> Commander Gateway
  -> authenticated Agent session
```

The private control socket is part of the Commander public client/API boundary. It is not an Agent protocol replacement and it is not exposed over HTTP, Tailscale Funnel, LAN or the public Internet.

### Transport

- MCP transport: local stdio only.
- MCP implementation target: the current MCP SDK v2 modern protocol path; legacy protocol negotiation is rejected by the adapter entrypoint.
- Commander control transport: Unix-domain socket under the user runtime directory by default.
- Socket directory mode: `0700`.
- Socket mode: `0600`.
- An active existing socket fails closed as `control_socket_in_use`; only a stale socket may be removed.

### Device selection

One MCP adapter process is bound to one explicit `COMMANDER_MCP_DEVICE_ID`. The device must be online at adapter startup. Tools are generated only from that device session's advertised capabilities that also match the versioned Commander operation registry.

ADMIN operations are never exported by the Phase 6 MCP adapter.

A capability is re-read from the Gateway immediately before every MCP tool invocation. Therefore a capability removed after MCP tool discovery may remain visible in an already-connected MCP client's tool list, but it cannot execute. Reconnect/restart refreshes advertisement. This intentionally favors fail-closed execution over implicit privilege persistence.

### Operation mapping

Tool names are versioned and deterministic:

```text
Commander operation: device.health
MCP tool:            commander_v1_device_health
```

The MCP input contains bounded `params`, optional `timeoutMs`, and a mandatory `idempotencyKey` for Commander operations whose contract requires idempotency. The adapter creates a correlation request ID and sends a normal versioned Commander `OperationRequest` through `CommanderPublicClient`.

The MCP result is the validated Commander `OperationResult`. Failures are represented as structured `CommanderError` values. Unexpected transport/internal exceptions are sanitized; raw exception text and stack traces are not returned to MCP clients.

## Trust boundary

MCP is not a trust root. The adapter cannot:

- authenticate an Agent;
- add a capability to an Agent session;
- widen Gateway authority;
- bypass READ/WRITE/ADMIN policy;
- bypass approval semantics;
- omit idempotency for mutating operations;
- convert a denied typed operation into generic shell access.

The Gateway and Agent remain authoritative for execution and policy decisions.

## Consequences

Positive:

- Commander remains usable by non-MCP clients through `CommanderPublicClient`.
- MCP process failure is isolated from Gateway/Agent session state.
- no new public listener or Funnel route is introduced;
- Phase 7 can reuse the same public client boundary instead of importing MCP.

Trade-offs:

- one adapter process targets one device;
- dynamic capability removal is enforced immediately but tool-list disappearance requires MCP reconnect/restart;
- stdio is local-only by design in Phase 6.

## Rejected alternatives

### MCP adapter imports Gateway or Agent internals

Rejected: violates ADR-001 and would couple integrations to security-sensitive internals.

### Streamable HTTP / public MCP endpoint

Rejected for Phase 6: unnecessarily expands authentication and network attack surface before pilot evidence exists.

### Generic shell MCP tool

Rejected: breaks the typed-operation policy and would bypass Commander capability governance.

## Acceptance evidence

Phase 6 requires tests proving:

- public control socket permissions and active-socket fail-closed behavior;
- only enabled non-ADMIN capabilities are exposed;
- capability revocation prevents execution even after tool discovery;
- mutating tools retain idempotency requirements;
- stdio interoperability with a modern MCP client;
- unexpected failures do not leak raw error text;
- full existing Commander test and syntax/policy suites remain green.
