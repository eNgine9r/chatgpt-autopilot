# Commander PRIMARY Cutover Runbook

Status: PRIMARY-ready for normal remote development and control.
Accepted runtime source: `2d4a1c0c44a80e639694cdfb3c941a26b4ff7189`.
Accepted devices: `btc-radar`, `nexolab-edge-01`.

## Primary transport

ChatGPT/GitHub client -> owner-authored issue labeled `commander/task` -> local GitHub Bridge on `btc-radar` -> Commander Gateway over the private local/Tailscale boundary -> authenticated Agent on the target host. No public inbound port is required on either Raspberry Pi.

The bridge accepts only the configured repository/label/OWNER author and strict versioned JSON. Every mutation requires an idempotency key. Generic shell text from an issue is never executed.

## Accepted capability set

- READ: health, bounded file/list/info/search, process metadata, allowlisted service status, Git status/diff/log.
- FILE WRITE: create/replace/edit/move/delete plus bounded directory create/remove inside allowlisted workspace roots.
- EXECUTION: fixed aliases only; shell executables remain denied; output, timeout, cancellation and concurrency are bounded.
- GIT: controlled commit and push on `commander/*` only; protected branches remain denied. Controlled commits support create/modify/delete and bypass hooks/clean filters. HTTPS push uses bounded GitHub AskPass; credentials are not placed in Git argv or issue payloads.
- SERVICE: only explicitly allowlisted user services may be started/restarted/stopped according to policy.
- ADMIN: remains disabled. Commander does not grant reboot/sudo, trading authority, Modbus/hardware writes or arbitrary production deployment authority.

## Normal development workflow

1. Refresh the isolated Commander workspace with the fixed fetch alias.
2. Reset the `commander/*` workspace branch to `origin/main` before a new task when a clean baseline is required.
3. Read/inspect files through bounded READ operations.
4. Create/edit/move/delete files through controlled WRITE operations.
5. Run only the predeclared validation aliases needed by the project.
6. Commit selected paths through controlled `git.commit`.
7. Push the `commander/*` branch through controlled `git.push`.
8. Open/review/merge the PR through GitHub.
9. Use an allowlisted service restart only when the deployment/runbook explicitly requires it.

## Workspace policy

`btc-radar` hosts isolated Commander workspaces for `chatgpt-autopilot` and `btc-radar-telegram`. `nexolab-edge-01` hosts the isolated `nexolab-platform` workspace. Normal source changes are made in these workspaces, not directly in dirty production checkouts.

For NEXOLAB SSH remotes, fixed network Git aliases set `GIT_SSH_COMMAND=/usr/bin/ssh -F /dev/null -o BatchMode=yes -o ClearAllForwardings=yes`. This avoids host system SSH drop-ins while preserving the user key and noninteractive fail-closed behavior.

## Reconnect and persistence

Commander Gateway, GitHub Bridge and local Agent on `btc-radar`, plus the Agent on `nexolab-edge-01`, are systemd user services. They are expected to restart automatically after user-service/reboot recovery and reconnect through the authenticated Gateway. Prior real-host acceptance covered reboot, network-loss/reconnect and service restart behavior; current cutover acceptance additionally revalidated Agent/Gateway/Bridge restarts and both-device execution.

## Rollback independent of Commander and RDC

Rollback must be executable from a local console or an existing SSH/Tailscale shell without using Commander or Remote Desktop Commander.

On `btc-radar` set `XDG_RUNTIME_DIR=/run/user/$(id -u)` and `DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus`, then stop `chatgpt-autopilot-commander-github-bridge.service`, `chatgpt-autopilot-commander-gateway.service` and `chatgpt-autopilot-commander-agent.service` with `systemctl --user stop`. Do not delete policies/secrets/workspaces during rollback.

On `nexolab-edge-01` set the same user-bus variables and stop `chatgpt-autopilot-commander-agent.service`.

To restore Commander, start the same units and verify `ActiveState=active`, `SubState=running`, then submit `device.health` for both devices before allowing mutations.

## Acceptance evidence

- GitHub Bridge: PR #208; polling lifecycle fix: PR #210.
- Self-contained controlled Git identity: PR #233.
- Noninteractive bounded GitHub HTTPS push auth: PR #238.
- Safe tracked-file deletion commits: PR #251.
- Real E2E passed for both devices: health/read, file write/read/delete, directory cleanup, fixed execution lifecycle, controlled Git commit/push, allowlisted service restart.
- Remote refs independently matched Commander-reported SHAs for Autopilot, BTC Radar and NEXOLAB acceptance branches.
- Post-acceptance workspaces were refreshed and reset to `origin/main` through Commander fixed aliases.

## RDC status

Remote Desktop Commander is no longer the normal development/control path. Keep it only as a temporary deprecated fallback until a separate explicit decommission decision. No Commander rollback procedure depends on RDC.
