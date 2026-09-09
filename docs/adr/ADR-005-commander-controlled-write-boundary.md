# ADR-005 — Commander Controlled Write Boundary

Status: Accepted for Phase 5 implementation and disposable/non-production acceptance only.

## Context

Commander Phase 4 proved bounded Agent-owned execution. Phase 5 adds narrowly scoped mutation without turning Commander into a generic remote shell or silently granting production-control authority. Repository governance previously allowed product-repository writes only through Codex sandbox policy, so Issue #187 explicitly authorizes only the Commander implementation and disposable acceptance described here.

## Decision

Controlled writes are a separate capability set gated by `COMMANDER_WRITE_ENABLED`. `COMMANDER_ADMIN_ENABLED` remains unsupported and startup fails closed if it is enabled. The default staged Agent/Gateway environment keeps both flags false.

Every mutation is evaluated against a versioned local policy before execution. Decisions are `allow`, `approval`, or `deny`. `approval` is non-mutating unless an injected verifier accepts the approval proof; the production service wires no verifier in Phase 5, so approval-required rules remain blocked.

Filesystem writes use canonical allowlisted roots, secret/symlink denial, bounded payloads, atomic temp-file replacement, evidence hashes and rollback metadata. Concurrent and replayed mutation requests are deduplicated by idempotency key plus semantic fingerprint.

User-service mutation is limited to explicit `.service` allowlists and fixed `systemctl --user` actions. No system services, sudo or arbitrary systemctl arguments are exposed.

Git commit is implemented with plumbing (`hash-object --no-filters`, `update-index --cacheinfo`, `write-tree`, `commit-tree`, CAS `update-ref`) rather than `git add`/`git commit`. Hooks, fsmonitor, credential helpers, external diff, signing and `ext::` transport are disabled. Push requires the configured remote alias to resolve to the exact policy `remoteUrl`; protected/unapproved branches fail closed.

`process.terminate` is not advertised in Phase 5. Commander can cancel only process trees it owns through the Phase 4 execution lifecycle.

## Deployment boundary

The staged systemd Agent remains `ProtectSystem=strict` and `ProtectHome=read-only`; Phase 5 does not add project paths to `ReadWritePaths`. Therefore merging this implementation cannot make production home/project repositories writable through the staged service. A later pilot/cutover must explicitly add only the required writable paths and pass a separate rollout gate.

## Consequences

Phase 5 provides a tested mutation substrate while keeping production behavior unchanged. Autopilot Core still does not obtain generic shell, ADMIN, trading, Modbus/hardware or product-domain authority.
