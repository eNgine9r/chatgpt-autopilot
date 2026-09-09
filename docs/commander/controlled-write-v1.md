# Commander Controlled Write v1

Phase 5 implements only these WRITE operations: `file.write`, `file.edit`, `file.move`, `service.start`, `service.stop`, `service.restart`, `git.commit`, and `git.push`. `process.terminate` is intentionally not advertised because Phase 4 `execution.cancel` already owns and terminates Commander-started process trees. No ADMIN operation is exposed.

## Feature gates

`COMMANDER_WRITE_ENABLED=false` is the default on Agent and Gateway. `COMMANDER_ADMIN_ENABLED=false` is staged and Phase 5 rejects startup if it is set true. `COMMANDER_EXECUTION_ENABLED` remains independent. A WRITE request succeeds only when the Gateway authority, Agent capability advertisement, Agent authority and local write policy all permit it.

## Policy

The policy has version `1` and independent `roots`, `services`, and `repositories`. Each rule resolves to `allow`, `approval`, or `deny`. More-specific filesystem roots win, and repository decisions are combined with the containing root using the stricter decision. Protected branches always deny.

Filesystem rules specify canonical root path and maximum file bytes. Existing symlinks, paths outside roots and credential-like paths are denied. `file.edit` is UTF-8 only and requires an exact expected replacement count. Writes use a same-directory temporary file and atomic rename.

Repository rules specify an alias, canonical repo path, commit/push decisions, remote alias, exact expected `remoteUrl`, allowed branch patterns and protected branch patterns. Git commits reject any pre-existing staged changes and only commit selected existing regular files.

## Approval and idempotency

Approval-required mutations return a structured `REQUIRES_APPROVAL` result before mutation unless an injected verifier accepts the request proof. Approval proof is excluded from the semantic idempotency fingerprint so the same intended mutation can be resubmitted after approval.

Successful mutations are replay-safe. Concurrent requests with the same idempotency key and fingerprint share one in-flight mutation; conflicting reuse of the same key fails. Replays get the caller's current transport `requestId` while retaining the original evidence.

## Evidence

Successful operations return structured evidence describing the affected resource, before/after state or hashes, and whether mutation occurred. Rollback metadata is included where practical, but Phase 5 does not auto-rollback production state. Operators or later orchestration layers must evaluate rollback actions explicitly.

## Git execution hardening

Git write commands use `shell:false`, a sanitized environment, disabled system/global Git config, fixed SSH command ignoring user SSH config, disabled hooks/fsmonitor/credential helpers/signing/external diff and `protocol.ext.allow=never`. Commit uses Git plumbing with `--no-filters`; push verifies the exact policy remote URL before mutation.
