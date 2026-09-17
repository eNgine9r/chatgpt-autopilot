# Commander Work Session v1

Phase 12 adds a persistent engineering-context layer for Commander. It is designed for interactive RDC replacement, not autonomous project execution.

## Operations

- `work_session.list` — discover stored sessions for the selected device.
- `work_session.open` — create/reuse one active session for a project/workspace.
- `work_session.get` — read the stored checkpoint.
- `work_session.resume` — compare current repository state with the stored checkpoint and report divergence.
- `work_session.checkpoint` — explicitly accept the current repository/cwd/resume note as the new baseline.
- `work_session.close` — preserve a final checkpoint and close the session.

Other Commander operations may include top-level `workSessionId`. Before a scoped mutation Commander compares the current repository branch, HEAD, bounded Git status hash and hashed origin identity with the checkpoint. A mismatch fails closed until an explicit checkpoint.

## Persisted data

The Agent persists device/project/workspace paths, cwd, Git branch/HEAD, dirty-state count and bounded status summary, hashes used for divergence checks, recent execution state, last operation metadata/evidence and a resume note up to 4 KiB.

Commander does not persist raw command history, arbitrary read results, browser cookies, tokens, SSH keys, environment secrets or unbounded stdout/stderr.

## Recovery semantics

MCP reconnect or Gateway restart: session remains unchanged. Agent restart: any stored non-terminal execution becomes `interrupted` with reason `agent_restart`. Repository changes made outside Commander are surfaced by `resume` and block the next scoped mutation until `checkpoint`.
