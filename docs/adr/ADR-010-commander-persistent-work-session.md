# ADR-010 — Commander Persistent Work Session

- Status: Accepted for Phase 12 implementation
- Date: 2026-09-17
- Tracking issue: #363

## Context

Commander can already execute bounded engineering operations, but an MCP/client reconnect does not itself preserve the human/AI working context. A Remote Desktop Commander replacement needs to recover the exact device/project/workspace, repository state, active Commander execution references and the last safe continuation point without introducing an autonomous scheduler.

## Decision

Commander Agent owns a private, versioned `WorkSession` store. The public operations are `work_session.list/get/resume/open/checkpoint/close`. MCP remains a thin adapter and never becomes the source of truth.

Each open session stores only bounded operational metadata: device/project/workspace identity, cwd, repository branch/HEAD plus a hash and bounded summary of Git status, active/recent execution state, last operation metadata/evidence and a bounded resume note. Raw shell history, credentials, browser state, arbitrary file contents and unbounded stdout/stderr are not persisted.

`work_session.open/checkpoint/close` use WRITE authority and idempotency. `list/get/resume` use READ authority. Existing Commander operations may carry an optional `workSessionId`; scoped mutations are rejected with `WORK_SESSION_DIVERGED` when branch/HEAD/status/origin identity differs from the stored checkpoint. `checkpoint` is the explicit re-sync operation.

The state file is mode 0600 in a mode 0700 directory and is replaced atomically. Agent startup marks previously non-terminal stored executions `interrupted`; Gateway or MCP reconnect does not do so because the Agent-owned execution engine may still be alive.

## Consequences

- ChatGPT can discover open sessions after reconnect with `work_session.list` and continue through `work_session.resume`.
- Gateway restart does not erase session context.
- Agent restart preserves context but reports formerly active execution state as interrupted rather than pretending success.
- Existing non-session Commander callers remain compatible because `workSessionId` is optional.
- No auto-continue loop, task queue or scheduler is introduced.
