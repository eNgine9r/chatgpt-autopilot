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

If Codex asks for approval, permission escalation, or another server-side request, the backend pauses and sends a Telegram alert rather than answering automatically.

## Rollout

1. Keep the project on `backend: "browser"` while preparing the worker.
2. Verify Codex authentication and App Server JSON-RPC handshake.
3. Install the restricted SSH forced-command key.
4. Run a read-only thread/resume acceptance test.
5. Switch only that project to `backend: "codex"`; keep `startOnBoot: false` for the first live observation.
6. After a real turn completes cleanly, enable `startOnBoot` and automatic continuation.
7. Keep the browser configuration available for rollback.

Do not cut over when the Codex account is usage-limited or when the target repository has unrelated active writes that could conflict with another worker.
