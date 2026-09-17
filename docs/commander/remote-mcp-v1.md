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
