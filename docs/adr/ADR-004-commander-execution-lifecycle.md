# ADR-004: Commander execution lifecycle

Status: Accepted for Phase 4 implementation; disabled by default in staged runtime.

## Context
Commander needs bounded long-running work without holding one request open or exposing an unrestricted terminal. Network sessions may reconnect while an owned process is still running.

## Decision
Executions are Agent-owned first-class records, independent of the TCP session. `execution.start` selects only a configured alias whose executable, argv, cwd, timeout and stdin policy are fixed in a local execution policy. Requests never carry an executable or shell string.

`COMMANDER_EXECUTION_ENABLED=false` is the default for both Agent and Gateway. When enabled explicitly, only READ plus the five execution lifecycle operations are accepted; ADMIN remains unavailable.

Each execution has bounded state, output and event history. stdout/stderr are streamed as validated execution events when the Gateway is online and remain retrievable from the Agent buffer after reconnect. Mutating execution requests are idempotent by key and parameter fingerprint.

Owned children start in their own process group. Timeout, cancel and Agent shutdown terminate the complete group with TERM followed by bounded KILL fallback. No implicit retry starts a second process after disconnect.

## Consequences
- reconnect does not own or restart the process; the Agent does;
- lost live events can be recovered with `execution.output`;
- a configured alias is the security boundary, not arbitrary argv supplied remotely;
- Phase 4 is not a general shell and adds no root or ADMIN authority;
- production enablement remains a later explicit gate.
