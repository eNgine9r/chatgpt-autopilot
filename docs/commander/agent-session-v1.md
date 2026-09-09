# Commander Agent session v1

This is the Phase 2 lifecycle layered on top of Commander protocol v1. It is a control-session protocol only; it contains no remote execution request.

## Flow

```text
Agent -> Gateway: TCP connect (outbound from Agent)
Gateway -> Agent: challenge
Agent -> Gateway: register + Device + HMAC proof
Gateway -> Agent: registered + fresh sessionId + heartbeat policy
Agent -> Gateway: heartbeat(sequence)
Gateway -> Agent: heartbeat_ack(sequence)
...
Agent -> Gateway: goodbye
```

On socket/Gateway loss the Agent reconnects with bounded exponential backoff and authenticates into a new session.

## Phase 2 deployment boundary

The reference Gateway service accepts only `127.0.0.1`, `::1`, or `localhost`. This intentionally prevents accidental remote exposure before the NexoLab pilot security gate.

A future remote pilot must preserve encrypted/private transport, per-device authentication, the same strict framing, and the deny-by-default operation contract.

## Secret layout

Agent config points to an absolute private secret file. Gateway config contains only a device-to-secret-file mapping:

```json
{
  "version": 1,
  "devices": {
    "device-id": "/absolute/private/path/to/device.secret"
  }
}
```

Secret files must not be group/world-readable. The mapping file contains no secret values.

## systemd staging

Run `npm run install:commander-services` only when staging is desired. It writes the two user units and default env files with `COMMANDER_ENABLED=false`, then reloads the user manager. It does **not** enable or start services.

Agent and Gateway should remain disabled throughout Phase 2 repository acceptance.
