# Commander Remote MCP v1

## Purpose

Phase 14 exposes Commander through a private modern Streamable HTTP MCP endpoint suitable for a later approved ChatGPT app/plugin connection. It does not expose the Commander Gateway or Agent directly and does not add Autopilot scheduling.

## Runtime

The staged service is `chatgpt-autopilot-commander-remote-mcp.service` and is disabled by default. Configuration lives in `~/.config/chatgpt-autopilot-commander/remote-mcp.env`; the dedicated bearer token lives in `remote-mcp.token` with mode 0600.

Required values when enabling acceptance are `COMMANDER_REMOTE_MCP_DEVICE_ID` and the existing local Commander control socket. `COMMANDER_REMOTE_MCP_HOST` defaults to `127.0.0.1`, port defaults to `8792`, and the MCP route is `/mcp`.

## Network boundary

Loopback is always allowed. Private remote acceptance may set the host to the exact local `tailscale0` IP and enable `COMMANDER_REMOTE_MCP_PRIVATE_BIND_ENABLED=true`. Wildcard, ordinary LAN, hostname and Funnel/public binds are rejected by the shared Commander bind policy.

## Authentication

Every `/mcp` request must present `Authorization: Bearer <token>`. Authentication occurs before request-body parsing, tool discovery or Commander device lookup. The token is independent from the device Ed25519 pairing identity and from Google/OIDC operator login.

## ChatGPT/app connection boundary

A ChatGPT-side MCP/app connection targets the remote MCP endpoint, never the Gateway/Agent port. A future approved secure tunnel may terminate in front of this adapter. Phase 14 itself does not create such a tunnel or Internet route. Standards-based MCP OAuth can replace the bearer verifier later without changing Commander contracts, policy or Agent trust.

## Continuity

The remote MCP adapter is stateless with respect to project work. The persisted Agent-side `WorkSession` is the source of truth, so a new MCP client connection can call `work_session.resume` and continue from the last checkpoint.

## Multi-device mode

For a single ChatGPT/operator connection controlling several paired Commander Agents, set `COMMANDER_REMOTE_MCP_MULTI_DEVICE_ENABLED=true` and omit `COMMANDER_REMOTE_MCP_DEVICE_ID`. The adapter registers `commander_v1_device_list` plus the union of currently advertised non-ADMIN operations from online devices.

Every operation tool in multi-device mode requires an explicit `deviceId`. The adapter re-reads that selected device immediately before forwarding the operation and fails closed with `OPERATION_NOT_ADVERTISED` if the device is offline or the capability was revoked. A fresh MCP connection refreshes the visible union when device capabilities change.

Single-device mode remains unchanged and does not require `deviceId` in each tool call.

## Interactive operator terminal

Commander does not create a second shell protocol. An operator terminal is an explicit execution-policy alias that starts an unprivileged shell through the existing `execution.start/get/output/input/cancel` lifecycle. The alias is runtime opt-in, runs as the Commander Agent service user, inherits execution concurrency/output/time bounds, and does not grant ADMIN or root authority.

A managed host may opt in with `interactiveShell: { enabled: true, cwd: <approved absolute path>, timeoutMs: <bounded> }`. Commander then synthesizes the fixed `operator.shell` alias as `/usr/bin/setpriv --no-new-privs /bin/bash --noprofile --norc` with `allowStdin=true`. Ordinary command aliases still reject shell executables. The feature is intentionally absent from the repository example policy because it expands user-level authority and must be accepted per host.
