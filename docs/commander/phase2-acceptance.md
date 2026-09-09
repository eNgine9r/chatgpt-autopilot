# Commander Phase 2 acceptance

Issue: #184
Baseline: `02e540b61e1f555ea07269ef6ffd97a9b8174fe8`
Date: 2026-09-09

## Deterministic evidence

- Commander tests: 25/25 PASS.
- Full Node repository suite: 313/313 PASS.
- Browserless suite: 157/157 PASS.
- `npm run check`, `npm run check:browserless`, shell syntax checks and `git diff --check`: PASS.
- Negative tests cover wrong secrets, stale heartbeat sequence, replaced sessions, non-loopback Gateway bind, open secret-file permissions, malformed/oversized framing and reconnect cancellation.

## Raspberry Pi ephemeral shadow acceptance

Acceptance was run from the isolated Phase 2 Git worktree, not from the production Autopilot checkout. No systemd unit was installed or enabled and no Funnel/runtime configuration was changed.

A temporary Gateway and Agent were launched on `127.0.0.1` with private files under `/tmp`:

- registration/HMAC authentication: PASS;
- Agent state: `disconnected -> connecting -> authenticating -> online`;
- Gateway listener: loopback only;
- identity file mode: `0600`;
- Agent secret file mode: `0600`;
- graceful SIGTERM cleanup: PASS, both processes stopped.

Measured after stabilization on the `btc-radar` Raspberry Pi:

| Process | RSS | steady CPU over 2 s |
| --- | ---: | ---: |
| Gateway | 54,720 KiB | 0.000% |
| Agent | 52,112 KiB | 0.500% |

The staged systemd units independently cap each process at `MemoryMax=192M` and `TasksMax=32` with `UMask=0077`, `NoNewPrivileges=true`, `ProtectSystem=strict` and no automatic enable/start.

## Production status

`COMMANDER_ENABLED` remains `false` by default. No Commander Agent/Gateway is running as a production service. Remote Desktop Commander and the existing Autopilot v3 restricted SSH path remain unchanged.
