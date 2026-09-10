# Commander Phase 8 — NexoLab shadow pilot

This runbook governs the first real-host Commander pilot between `btc-radar` (central Gateway) and `nexolab-edge-01` (managed Agent). Remote Desktop Commander remains the primary/fallback engineering path throughout Phase 8.

## Network boundary

The Agent session uses the private Tailscale interface only. The Gateway must bind to the exact `tailscale0` address on `btc-radar`, guarded by `COMMANDER_PRIVATE_BIND_ENABLED=true`. Do not use `0.0.0.0`, a LAN address, Tailscale Funnel, or a public listener. The Gateway control API remains a local Unix socket.

Observed preflight addresses on 2026-09-10:

- `btc-radar`: `100.72.160.97`;
- `nexolab-edge-01`: `100.113.204.81`.

These addresses are evidence for the current pilot only; stable Commander device identity must not depend on them. Re-resolve the local `tailscale0` address before each activation.

## Staged order

1. Verify current `main`, clean isolated installation source, Node.js availability, Tailscale peer reachability, and Remote Desktop Commander fallback.
2. Stage Commander user-systemd units/config on both hosts with all feature flags disabled.
3. Provision a dedicated per-device Commander secret and Gateway secret map with mode-0600 files. Never print secret values.
4. Configure the NexoLab read policy narrowly to the approved repository and explicitly approved user services. Leave WRITE/ADMIN disabled.
5. Configure the central Gateway to its current `tailscale0` address with private bind enabled.
6. Explicitly enable/start Gateway, then Agent; verify authenticated registration and heartbeat.
7. Run shadow READ comparisons only.
8. Verify reconnect after Agent/Gateway restart and controlled network interruption.
9. Reboot acceptance is a separate operator gate.
10. Controlled WRITE may be tested only in disposable/non-production scope after its independent acceptance gate.

## Stage 1 machine preflight

After staging, run the read-only preflight from an accepted Commander source tree:

```bash
npm run preflight:commander-phase8 -- \
  --repo <staged-source> \
  --expected-head <40-char-accepted-main-sha> \
  --tailscale-ip <current-local-tailscale0-ip> \
  --port 8790 \
  --fallback-process 'desktop-commander remote'
```

The JSON result must have `ok:true`. Any unknown git/systemd/listener/process state fails closed. The preflight performs reads only; it does not enable, start, restart, stop, or reconfigure services.

## Fail-closed conditions

Stop the pilot and use Remote Desktop Commander if the Gateway cannot prove a `tailscale0` bind, device authentication fails, device identity changes unexpectedly, capability advertisement exceeds the approved set, secrets appear in logs, or the fallback path becomes unavailable. Do not silently fall back to another Commander transport.

## Rollback

Disable Commander on both hosts, stop/disable the Commander user services, remove only pilot-specific secret/config files after evidence capture, and leave the existing Remote Desktop Commander and Autopilot runtime untouched. No rollback step depends on Commander itself.
