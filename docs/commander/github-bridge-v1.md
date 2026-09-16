# Commander GitHub Bridge v1

## Purpose

Provide a reversible ChatGPT-to-Commander control path when direct Remote Desktop Commander access is unavailable. The bridge polls GitHub; it opens no inbound network listener.

## Task contract

Create an open issue in the configured repository with label `commander/task`. The issue body must be JSON only:

```json
{
  "version": 1,
  "deviceId": "btc-radar",
  "operation": "device.health",
  "params": {},
  "timeoutMs": 10000
}
```

For Commander operations that require idempotency, add:

```json
{
  "idempotencyKey": "stable-caller-key"
}
```

The bridge does not accept arbitrary shell command text.

## Result contract

A terminal task receives one comment beginning with:

```text
<!-- commander-result:v1 -->
```

followed by a bounded JSON `OperationResult` or sanitized bridge failure. The issue is then closed. Retryable Commander transport failures stay open for a later poll and are not converted into a false terminal failure.

## Configuration

`~/.config/chatgpt-autopilot-commander/github-bridge.env`:

```text
COMMANDER_GITHUB_BRIDGE_ENABLED=true
COMMANDER_GITHUB_REPOSITORY=eNgine9r/chatgpt-autopilot
COMMANDER_GITHUB_ALLOWED_AUTHOR=eNgine9r
COMMANDER_GITHUB_TASK_LABEL=commander/task
COMMANDER_GITHUB_POLL_MS=10000
```

`COMMANDER_GITHUB_ALLOWED_OPERATIONS` is optional. When absent, only Phase 3 READ operations are accepted. Add execution or controlled-write operations only after their Commander gates and target policy are accepted.

## Staged installation

```bash
COMMANDER_NODE_BIN=/absolute/path/to/node npm run install:commander-github-bridge
```

This only writes the bridge unit and private env file. It does not modify existing Agent/Gateway units and does not enable or start the bridge.

Before activation:

1. ensure the Gateway control socket is healthy;
2. ensure `gh auth status` resolves to the configured owner login;
3. create the configured GitHub task label;
4. keep the operation allowlist READ-only for initial acceptance;
5. enable the bridge env gate, then enable/start the systemd user unit;
6. prove end-to-end tasks against each online Commander device;
7. keep Remote Desktop Commander as fallback until Phase 10 acceptance is recorded.

Rollback is independent of Commander: stop/disable `chatgpt-autopilot-commander-github-bridge.service` and set `COMMANDER_GITHUB_BRIDGE_ENABLED=false`. Agent/Gateway remain unchanged.
