# ADR-002: Commander Agent session and authentication

- Status: Accepted for Phase 2 foundation
- Date: 2026-09-09
- Tracking issue: #184
- Contract baseline: Commander protocol v1 from #194

## Context

Commander needs a stable Linux Agent lifecycle before any remote device action is implemented. The Agent must survive network/Gateway loss, authenticate as a known device, avoid IP-based identity, and fail closed on duplicate or stale sessions.

Phase 2 must not create a public command listener or weaken the existing Autopilot v3 restricted SSH boundary.

## Decision

The Agent initiates an outbound framed session to a Commander Gateway. The Phase 2 reference transport is bounded newline-delimited JSON over TCP, but the Gateway service is restricted to loopback only. This transport exists to prove session semantics; it is not authorization to expose raw TCP on a LAN or the public Internet.

Before a remote-host pilot, transport must run inside an explicitly approved encrypted/private channel (for example Tailscale/private networking) or gain an additional TLS transport layer. Removing the Phase 2 loopback restriction requires a separate reviewed change.

## Device identity

The Agent persists a random stable `deviceId` in a mode-0600 state file. Identity does not derive from DHCP, LAN IP, Tailscale IP, hostname or MAC address. An explicitly configured bootstrap ID may be used once; a later mismatch fails closed.

## Authentication

Each managed device has a distinct random secret of at least 32 bytes stored in a private file. The secret itself is never placed in the Gateway mapping file, protocol message or structured log.

Registration uses HMAC-SHA256 challenge-response:

1. Gateway creates a random challenge ID and nonce with a 30-second lifetime.
2. Agent validates challenge freshness.
3. Agent computes HMAC over protocol name/version, challenge ID, nonce, stable device ID and Agent version.
4. Gateway resolves the expected per-device secret and validates the proof using timing-safe comparison.
5. Gateway allocates a fresh random session ID only after successful proof validation.

Captured registration proofs cannot authenticate against a fresh challenge.

## Session lifecycle

After registration, the only accepted Agent messages in Phase 2 are `heartbeat` and `goodbye`. Gateway replies with `heartbeat_ack`.

Heartbeat sequence numbers are strictly increasing per session. Heartbeats for an older/replaced session fail closed. Registering the same device again replaces the prior session and closes the previous connection.

The registry marks sessions offline after the heartbeat timeout. Gateway/socket loss causes the Agent to reconnect using bounded exponential backoff with jitter. A graceful Agent stop cancels reconnect and heartbeat timers.

## Resource bounds

- frame size is bounded;
- frame batches are bounded;
- registration has an authentication timeout;
- device registry size is bounded;
- heartbeat frequency/timeout is bounded;
- reconnect backoff is capped;
- one Agent instance owns one active socket;
- staged systemd units apply task/memory and privilege hardening.

## Feature gate

`COMMANDER_ENABLED` defaults to `false`. Agent and Gateway service entrypoints exit without connecting or listening while disabled.

The installer only stages user-systemd units and private config skeletons. It does not enable or start either service.

## Explicit non-capabilities

Phase 2 implements no file reads, shell/process execution, service control, Git actions, sudo, deployment, trading, Modbus/hardware access or Autopilot state mutation.

The Agent advertises an empty capability list until later phases implement real typed operations.

## Consequences

The session layer can now be tested independently from device operations, and future Phase 3 capabilities can rely on stable authenticated device/session identity. Remote production exposure remains intentionally blocked until a later pilot-specific transport review.
