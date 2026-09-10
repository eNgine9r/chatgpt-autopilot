# ADR-008: Commander Tailscale-only private Gateway bind

- Status: Accepted for Phase 8 transport gate
- Date: 2026-09-10
- Tracking issue: #190
- Depends on: ADR-002, ADR-007

## Context

Phase 2 deliberately restricted the Commander Agent TCP session listener to loopback. That was sufficient for protocol/session development but prevents a real NexoLab Agent from reaching a central Gateway on another Raspberry Pi. Phase 8 requires a reviewed private-network transport before any real-host shadow pilot.

Both pilot hosts already participate in the same authenticated Tailscale network. Commander must use that private interface without turning the Agent session listener into a LAN, wildcard, Funnel, or public listener.

## Decision

Loopback remains the default and requires no new flag. A non-loopback Gateway bind is accepted only when all conditions are true:

1. `COMMANDER_PRIVATE_BIND_ENABLED=true`;
2. `COMMANDER_GATEWAY_HOST` is a literal IP address;
3. the exact address is currently assigned to local interface `tailscale0`;
4. the address is not `0.0.0.0` or `::`.

The validation is performed before the TCP listener is created and again by `CommanderGatewayServer`. An address merely belonging to the Tailscale CGNAT range is insufficient if it is not assigned to the local `tailscale0` interface.

## Security properties

- Default Phase 2 loopback behavior is unchanged.
- LAN/Wi-Fi/Ethernet addresses are rejected even when the private-bind flag is enabled.
- Wildcard listeners are always rejected.
- Hostnames are rejected on the private-bind path to avoid DNS/interface ambiguity.
- Tailscale Funnel is not used.
- Agent HMAC challenge-response authentication remains mandatory.
- The private Unix control socket remains local to the Gateway host.
- No ADMIN, deployment, trading, Modbus, or hardware authority is added.

## Rollback

Set `COMMANDER_ENABLED=false` and stop/disable the staged Commander services. Restoring `COMMANDER_GATEWAY_HOST=127.0.0.1` and `COMMANDER_PRIVATE_BIND_ENABLED=false` returns the Gateway to the Phase 2 network boundary. Remote Desktop Commander remains independent of this rollback path.

## Consequences

Phase 8 may stage a real NexoLab Agent and central Gateway after this change is reviewed and merged. Service enablement, secret provisioning, reboot testing, network-loss testing, and any controlled write remain separate pilot acceptance steps.
