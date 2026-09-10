# Autopilot v3 Commander Client v1

## Configuration

Commander integration is opt-in at two levels. Global process gate:

```bash
COMMANDER_ENABLED=true
```

Per-project v3 config:

```json
{
  "commander": {
    "enabled": true,
    "deviceId": "nexolab-edge-01",
    "repoPath": "/home/nexolab/nexolab-platform",
    "testAliases": {
      "required": "v3-required"
    }
  }
}
```

The existing `repoPath` or `transport.type: "ssh-gateway"` configuration remains present and valid as the fallback path. Merely enabling Commander services does not migrate a project unless its own `commander.enabled` is also true.

## Runtime behavior

For Commander-enabled repository steps:

```text
repo.inspect
  -> git.status
  -> git.log(limit=1)

repo.test
  -> execution.start(fixed alias)
  -> execution.get until terminal
  -> execution.output
```

The v3 engine persists `lastFailure` for structured Commander failures and an `attempt` number for safe mutation retries.

A Commander-selected step never silently falls through to local/SSH execution after an error. Disable the project Commander gate to use the existing fallback backend.

## Failure mapping

Examples of deterministic blocked evidence include:

```text
commander:device_offline:DEVICE_OFFLINE
commander:timeout:COMMANDER_CONTROL_TIMEOUT
commander:policy:EXECUTION_ALIAS_DENIED
commander:approval:REQUIRES_APPROVAL
```

The detailed durable `lastFailure` object contains bounded classification fields only. Unexpected raw transport text is not stored.

## Retry model

The Commander write idempotency key is stable inside one v3 step attempt.

- ambiguous transport failure -> retry same attempt/key;
- known terminal/rejected execution -> increment attempt and use a new key.

This lets v3 recover from lost responses without duplicating remote work while still allowing an intentional retry after a completed failed test.

## Scope limits

Phase 7 does not:

- start Commander services in production;
- change target-host Commander allowlists;
- perform NexoLab or BTC Radar pilot activation;
- introduce ADMIN operations;
- remove restricted SSH or Remote Desktop Commander fallback.
