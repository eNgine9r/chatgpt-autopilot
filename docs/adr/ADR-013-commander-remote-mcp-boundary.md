# ADR-013 — Commander Remote MCP Boundary

- Status: Accepted for Phase 14 implementation
- Date: 2026-09-17
- Tracking issue: #420

## Decision

Commander adds a separately deployable Streamable HTTP MCP adapter. The dependency direction remains `remote MCP adapter -> CommanderPublicClient -> private control socket -> Gateway -> authenticated Agent`; the adapter does not import Gateway or Agent internals.

The endpoint is `/mcp`. Authentication is checked before MCP parsing or tool discovery. Initial private acceptance uses a dedicated bearer token stored only in a mode-0600 runtime file. The verifier is isolated so standards-based MCP/OAuth authorization can replace it without changing Commander Core. Device pairing credentials are never accepted as remote MCP credentials.

The adapter binds loopback by default. An exact IP assigned to `tailscale0` is accepted only with `COMMANDER_REMOTE_MCP_PRIVATE_BIND_ENABLED=true`. Wildcard, LAN and public/Funnel binding are rejected. Phase 14 does not add a public listener or route.

Each MCP request creates its tool surface from the device's current advertised capability snapshot. Only version-matched non-ADMIN typed operations are exported. Gateway/Agent policy, approvals and idempotency remain authoritative and are re-checked during execution.

## Continuity

MCP transport state is not the work-state authority. `WorkSession` remains persisted by the Agent, so an MCP client may disconnect and reconnect, then invoke `work_session.resume` without losing project/repository context. Adapter restart does not alter Gateway/Agent session state.

## Consequences

This provides the network-facing boundary needed for a ChatGPT app/plugin connection while retaining local stdio MCP as fallback and preserving the existing Commander trust boundaries. Production enablement and any secure external tunnel remain separate rollout decisions.
