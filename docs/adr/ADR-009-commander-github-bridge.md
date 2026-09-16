# ADR-009 — Commander GitHub Task Bridge

- Status: accepted for staged rollout
- Date: 2026-09-16
- Context: Remote Desktop Commander free tool-call access is becoming unavailable.

## Decision

Add an optional pull-based GitHub transport adapter for Commander:

```text
ChatGPT/GitHub client
  -> owner-authored labeled GitHub issue
  -> local Commander GitHub Bridge on btc-radar
  -> CommanderPublicClient over private Unix socket
  -> Commander Gateway
  -> authenticated Commander Agent
  -> bounded OperationResult
  -> GitHub issue comment + close
```

GitHub is transport only. It is not a Commander trust root and cannot bypass Commander capabilities, feature gates, policies, idempotency, or device authentication.

## Why this path

The existing MCP adapter is local stdio. The current ChatGPT web workflow needs a remote action path that remains usable without Remote Desktop Commander. A pull-based GitHub adapter reuses an already authenticated operational dependency and introduces no new public listener.

## Security boundary

The bridge accepts only issues that:

- belong to the configured repository and label;
- are authored by the configured GitHub login;
- have GitHub `author_association=OWNER`;
- contain strict versioned JSON within bounded size limits;
- request an operation in the bridge allowlist;
- request a capability currently advertised by the selected device.

ADMIN operations are always rejected. Mutating operations still require Commander idempotency keys. By default the bridge allowlist contains only the ten Phase 3 READ operations.

The service invokes `gh` directly with `execFile`; issue text is never evaluated by a shell. Unexpected failures are converted to bounded errors. The bridge does not expose credentials, environment dumps, or raw stack traces in issue comments.

## Deployment rule

The bridge has a dedicated installer and systemd unit. Installation is fail-closed: the generated environment has `COMMANDER_GITHUB_BRIDGE_ENABLED=false`, and the installer never enables or starts the unit. Production activation remains an explicit cutover action.

Remote Desktop Commander stays available as fallback during acceptance. Decommission is a separate decision after Commander-primary evidence is complete.
