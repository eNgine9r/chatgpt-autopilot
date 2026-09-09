# Commander security model

Status: Phase 0 baseline
Date: 2026-09-09
Tracking issue: #182

## Security objective

Commander must provide useful remote engineering capabilities without making possession of an AI/MCP/client session equivalent to unrestricted root access on every managed host.

The default posture is **deny by default, least privilege, bounded execution, explicit authority, auditable mutations, fail closed**.

## Trust boundaries

```text
AI / MCP / Autopilot client
          |
          | untrusted request parameters
          v
   Commander public boundary
          |
          v
  Gateway auth + policy + routing
          |
          | authenticated private device session
          v
     Commander Agent
          |
          | OS capability boundary
          v
 approved files/processes/services/repos
```

The client is not trusted to enforce policy. MCP is not a trust root. Autopilot is not allowed to bypass Gateway/Agent policy because it is an internal client.

## Threats in scope

- stolen/replayed client or device credentials;
- unauthorized device selection;
- path traversal and symlink escape;
- command/shell injection;
- secret disclosure through file reads, environment, command output or logs;
- duplicate mutations after retries/reconnects;
- unbounded process/output/resource consumption;
- privilege escalation;
- stale/duplicate Agent sessions;
- confused-deputy behavior between NexoLab, BTC Radar and future projects;
- public Internet exposure of remote execution surfaces;
- malicious or malformed MCP/client payloads;
- accidental product-domain actions caused by generic infrastructure access.

## Authority classes

### READ

Examples:

- device/system health;
- file metadata/read/list/search under approved roots;
- process listing;
- approved service status;
- Git status/diff/log metadata;
- bounded log reads.

READ must not imply access to credentials or all of `/`.

### WRITE

Examples:

- controlled project-file create/edit/move;
- owned bounded process execution;
- approved service restart;
- explicitly scoped Git writes.

WRITE is disabled by default and cannot imply ADMIN.

### ADMIN

Examples:

- sudo/root operations;
- reboot/shutdown;
- package installation;
- system/network configuration;
- privileged service/configuration mutation.

ADMIN is a separate capability and remains disabled until an explicitly scoped future issue authorizes exact operations and acceptance gates.

## Product-domain separation

Commander controls infrastructure capabilities, not product business authority.

Even if a host contains BTC Radar or NexoLab, Commander access does not automatically authorize:

- exchange/trading writes;
- wallet operations;
- Modbus/hardware writes;
- laboratory device control;
- deployment/cutover;
- database destructive operations.

Those actions require their own product policy and explicit issue/approval. Generic shell access must never be used to bypass those gates.

## Feature gates

Implementation defaults:

```text
COMMANDER_ENABLED=false
COMMANDER_WRITE_ENABLED=false
COMMANDER_ADMIN_ENABLED=false
```

A missing/invalid flag is treated as disabled.

Per-device/per-project capability policy is additionally required; a global enabled flag alone must not grant all operations.

## Filesystem policy

- explicit allowed roots per device/project;
- canonicalize paths before policy evaluation;
- reject traversal outside the allowed root;
- test symlink/junction escape behavior;
- separate read/write allowlists where useful;
- file-size and response-size limits;
- atomic/recoverable write patterns where practical.

Default denied classes include credential and private runtime stores such as:

- SSH private keys;
- `.env`/secret stores unless a very specific safe operation explicitly needs them;
- browser profiles/cookies/session data;
- API/token credential stores;
- system credential databases;
- private key material.

A caller asking to inspect a broad config/runtime surface must not cause Commander to return embedded secrets. Structured secret redaction is required for outputs that may contain environment/config values.

## Command/execution policy

Prefer structured execution:

```text
executable + argv[] + cwd + timeout + explicit environment allowlist
```

over concatenated shell strings.

Requirements:

- sanitized/minimal child environment;
- bounded timeout;
- bounded stdout/stderr buffers/chunks;
- process/concurrency limits;
- owned process-tree cancellation;
- explicit exit state;
- no implicit retry of a non-idempotent execution;
- stdin/input size limits;
- command/action allowlists for ordinary WRITE capability.

If a future workflow demonstrates a real need for free-form shell, it must be a separately named capability with explicit policy/audit and must not be the default path.

## Service policy

Service operations use explicit allowlists. A project-scoped WRITE capability should not be able to restart arbitrary system services.

Initial rollout should prefer user-systemd services where possible. Privileged/system service changes belong to ADMIN.

## Git policy

Read-only Git metadata belongs to READ.

Git writes must enforce:

- approved repository root;
- expected branch/HEAD where relevant;
- protected branch denial;
- bounded changed-file set;
- secret/denied path rules;
- no force push unless separately and explicitly authorized;
- deterministic evidence of resulting commit/ref.

Existing v3 deterministic publisher protections remain independent and are not weakened by Commander.

## Authentication and device identity

Each managed device has a stable logical `deviceId` independent of IP address.

Device sessions must be authenticated using dedicated Commander credentials. Credentials must not be reused from generic personal SSH, Codex forced-command SSH or unrelated product services.

Required properties:

- credential rotation/revocation;
- replay resistance/session freshness;
- duplicate/stale-session handling;
- explicit Gateway trust configuration;
- no credential values in logs or checkpoints.

Exact transport/auth technology is selected in Phase 1/2 and documented before live enablement.

## Network exposure

Prefer private connectivity such as Tailscale. Agents should establish/maintain controlled authenticated connectivity rather than exposing an arbitrary command API publicly.

Any public edge needed for an MCP/client adapter must terminate at a hardened Gateway boundary. Managed-device execution ports remain private.

## Request correlation and idempotency

Every operation carries a unique request ID. Long-running work also has an execution ID.

Mutating operations that could be replayed use an idempotency key or equivalent deterministic deduplication record.

On reconnect, the system must distinguish:

- operation never started;
- operation currently running;
- operation already completed;
- result delivery lost.

It must not guess and rerun a mutation merely because the client did not receive the first response.

## Output and secret handling

Never persist or forward raw secrets to:

- GitHub issues/PRs;
- Telegram;
- Autopilot checkpoints;
- routine structured logs;
- MCP metadata/results beyond the minimum operation result.

Outputs likely to include complete environment/configuration dumps require filtering/redaction before leaving the device boundary. Commands that enumerate effective container/process environments should not be ordinary READ operations.

Truncation must be explicit (`truncated: true`) so an AI/client does not mistake partial evidence for complete evidence.

## Audit events

Every security-relevant operation records a structured event containing only non-secret metadata such as:

- timestamp;
- request/execution ID;
- device ID;
- caller/client identity;
- operation name;
- capability class;
- policy decision;
- duration/result/error category.

Write/admin operations additionally record target identifiers and resulting evidence where safe.

Logs are bounded/rotated for Raspberry Pi storage constraints.

## Approval semantics

Policy can return at least:

- allowed;
- denied;
- `requires_approval`.

An approval is scoped to the exact operation/request context. It is not a permanent escalation token for future unrelated commands.

Physical actions, credentials, high-risk production cutovers and other operator gates remain explicit even when Commander technically can reach the host.

## Failure behavior

Fail closed on:

- unknown protocol version;
- unknown device/session;
- authentication failure;
- policy ambiguity;
- invalid path;
- unsupported capability;
- stale request/replay;
- output/resource limit uncertainty;
- Agent/Gateway version incompatibility.

Do not silently downgrade a denied typed operation into generic shell execution.

## Current repository governance

`AGENTS.md` currently permits remote SSH only through tightly restricted forced-command/Codex mechanisms and does not authorize general production control.

Phase 0 does not change that rule. Before new WRITE/ADMIN authority is enabled, its implementation issue must explicitly update governance where necessary and prove policy/rollback behavior.

## Rollout security gates

1. code/contracts with Commander disabled;
2. Agent registration/heartbeat only;
3. shadow READ on NexoLab;
4. restart/network-loss/reconnect acceptance;
5. controlled non-production WRITE only after explicit approval;
6. NexoLab pilot PASS;
7. BTC Radar pilot PASS;
8. explicit primary cutover;
9. Remote Desktop Commander remains independent fallback.

A failed stage does not automatically advance or widen permissions.

## Required security tests

At minimum:

- malformed contract/version;
- unauthenticated/expired/replayed session;
- wrong-device routing;
- path traversal;
- symlink escape;
- denied secret path;
- disabled write/admin feature flags;
- command/argument injection attempts;
- timeout and output bounds;
- cancellation/process-tree cleanup;
- duplicate/idempotent mutation;
- reconnect during execution;
- stale Agent session replacement;
- protected Git branch denial;
- audit redaction.

## Security acceptance principle

Commander is production-ready only when its safety properties are demonstrated on the real target environment. Passing unit tests alone does not authorize production mutation or Remote Desktop Commander decommission.