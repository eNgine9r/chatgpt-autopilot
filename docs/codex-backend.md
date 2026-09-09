# Codex App Server backend

Autopilot v0.3 adds a fault-isolated Codex supervisor alongside the existing Chromium/MV3 supervisor.

## Architecture

- `src/index.mjs` supervises only projects with `backend: "browser"`.
- `src/codex-supervisor.mjs` supervises only projects with `backend: "codex"`.
- Both runtimes may run at the same time and share Telegram configuration, but a crash in one does not terminate the other.
- Codex state is stored under `state/<project-id>.codex.json` with private permissions.
- A Codex thread is resumed by ID after supervisor restart.
- `turn/completed`, `thread/status/changed`, and item events drive progress; the 30-minute watchdog remains an independent dead-man alert.

## Security model

The recommended remote transport is SSH stdio. Do not expose the App Server websocket publicly.

Use a dedicated Ed25519 key whose `authorized_keys` entry combines `restrict`, a Tailscale source address, and a forced command that starts only:

```text
codex app-server --listen stdio://
```

The key must not provide an interactive shell, forwarding, PTY, or arbitrary remote commands.

## Runtime policy

The current tested Codex CLI protocol on NexoLab uses:

- approval policy `on-request`;
- thread sandbox `workspace-write`;
- turn sandbox policy `{ "type": "workspaceWrite", ... }`;
- network disabled by default;
- writable roots limited to the configured repository path.

Command/file escalation requests are never auto-approved: the backend responds `decline` and lets Codex find a sandbox-safe alternative. Standalone permission escalation receives an empty granted subset. Unknown server-side requests still pause the backend and send a Telegram alert. A `waitingOnApproval` status flag alone is observational; the concrete server request determines whether it can be safely denied or requires the user.

## Rollout

1. Keep the project on `backend: "browser"` while preparing the worker.
2. Verify Codex authentication and App Server JSON-RPC handshake.
3. Install the restricted SSH forced-command key.
4. Run a read-only thread/resume acceptance test.
5. Switch only that project to `backend: "codex"`; keep `startOnBoot: false` for the first live observation.
6. After a real turn completes cleanly, enable `startOnBoot` and automatic continuation.
7. Keep the browser configuration available for rollback.

Do not cut over when the Codex account is usage-limited or when the target repository has unrelated active writes that could conflict with another worker.

## Intentional idle / shadow mode

For a Codex project that is intentionally kept idle (`autoContinue: false`), set `watchdogEnabled: false` to suppress generic no-progress/heartbeat alerts. Transport exits still trigger the Codex backend alert path, so SSH/App Server failures remain visible.

## Marker-driven continuation

Codex auto-continuation is fail-closed and marker-driven. A completed agent turn must end with exactly one control marker:

- `[[AUTOPILOT_CONTINUE]]` — a concrete safe next action exists; start the next turn after `completionSettleSeconds`.
- `[[AUTOPILOT_WAIT]]` — external evidence such as CI is still pending; poll again after `codex.waitSeconds` (default 300 seconds).
- `[[AUTOPILOT_COMPLETE]]` — the current autonomous work is complete; do not create another model turn.
- `[[AUTOPILOT_PUBLISH]]` — source/tests are ready, but Git metadata is sandbox-protected; hand the tracked diff to the deterministic restricted publisher, then continue.
- `[[USER_ACTION_REQUIRED]]` — pause the project and notify the operator.

Missing or ambiguous markers pause the backend instead of silently looping. This keeps GitHub/status monitoring deterministic and avoids unnecessary model usage when no reasoning work is available.

## Deterministic Git publisher

When `codex.publisher.enabled` is true, Codex never receives write access to `.git`. Before each reasoning turn the publisher records a clean tracked-worktree baseline. `[[AUTOPILOT_PUBLISH]]` succeeds only if the current HEAD still matches that baseline, the branch matches `.project/ACTIVE_SPRINT.json`'s active Work Package and is not `main`/`master`, `git diff --check` passes, and no non-cache untracked source is present. The restricted gateway stages tracked changes only, creates one non-GPG commit, and pushes that exact feature branch without force or merge.
