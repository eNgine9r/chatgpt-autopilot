# Commander MCP Adapter v1

## Purpose

Phase 6 exposes the existing Commander typed-operation model to local MCP clients without changing the Gateway/Agent trust boundary.

```text
MCP client -> stdio adapter -> CommanderPublicClient -> private Unix socket -> Gateway -> Agent
```

There is no public MCP listener and no Tailscale/Funnel route in this phase.

## Runtime configuration

The adapter entrypoint is:

```bash
COMMANDER_MCP_DEVICE_ID=<device-id> npm run start:commander-mcp
```

Optional:

- `COMMANDER_CONTROL_SOCKET=/absolute/path/gateway.sock` overrides the private control socket path.
- otherwise the socket is `${XDG_RUNTIME_DIR}/chatgpt-autopilot-commander/gateway.sock`, falling back to `/run/user/<uid>/chatgpt-autopilot-commander/gateway.sock`.

The Gateway creates the control socket only while Commander itself is enabled. Default Commander feature flags and production behavior remain unchanged.

## MCP tool contract

Each tool maps exactly one Commander operation:

```text
<operation>                  <MCP tool>
device.health                commander_v1_device_health
file.read                    commander_v1_file_read
execution.start              commander_v1_execution_start
```

The complete exported set is derived from the selected online device's current advertised capabilities. Phase 6 suppresses ADMIN capabilities even if they appear in a malformed or future capability snapshot.

Common input:

```json
{
  "params": {},
  "timeoutMs": 1000
}
```

Mutating operations additionally require:

```json
{
  "idempotencyKey": "caller-stable-key"
}
```

`params` are passed as Commander operation parameters; the Agent-side typed capability remains responsible for operation-specific policy/argument validation. This adapter does not create a generic command or shell operation.

## Result and error semantics

Successful and failed tool calls preserve the Commander v1 `OperationResult` shape. Failed Commander results are MCP error tool results and retain a structured `CommanderError`.

Adapter/control failures are converted into bounded errors. Raw stack traces, local exception messages, Agent secrets, Gateway secret-map contents and process environment dumps are not MCP output.

## Capability changes

The adapter does two checks:

1. startup tool discovery uses the selected online device session's allowed capability snapshot;
2. every invocation fetches the current device snapshot again before forwarding the request.

If WRITE is disabled or a capability disappears, a previously discovered tool fails closed with `OPERATION_NOT_ADVERTISED`; it is not forwarded to the Gateway execution path. A fresh MCP connection refreshes the visible tool list.

## Security properties

- MCP has no Agent credential material.
- MCP does not decide Gateway authority.
- ADMIN is unavailable.
- writes still depend on Commander feature gates, Agent advertisement, policy and approval state.
- mutating operations retain the Commander idempotency key contract.
- request/output limits remain bounded by Commander contracts and framing.
- the private control API is local Unix socket only (`0700` parent, `0600` socket).
- an already-active socket is never unlinked by another Gateway instance.

## Non-goals

Phase 6 does not provide:

- remote/public MCP transport;
- arbitrary shell execution;
- production Commander cutover;
- Autopilot v3 migration to Commander;
- NexoLab/BTC Radar pilots;
- removal of Remote Desktop Commander fallback.

Those remain later roadmap phases.
