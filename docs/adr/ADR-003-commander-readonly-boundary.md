# ADR-003: Commander Phase 3 read-only capability boundary

- Status: Accepted for Phase 3
- Date: 2026-09-09
- Tracking issue: #185
- Depends on: ADR-001, ADR-002

## Context

Commander Phase 2 established authenticated device sessions but intentionally provided no device actions. Phase 3 needs useful engineering visibility without creating a generic remote shell or introducing WRITE/ADMIN authority.

## Decision

Phase 3 exposes only typed READ operations advertised by the Agent and defined in the versioned Commander contract. Gateway requests are routed over the existing authenticated session; no new public HTTP, SSH, shell or socket surface is introduced.

Implemented Phase 3 operations:

- `device.health`;
- `file.read`, `file.list`, `file.info`, `file.search`;
- `process.list`;
- `service.status`;
- `git.status`, `git.diff`, `git.log`.

`execution.get/output` remain contract vocabulary for Phase 4 and are not advertised by the Phase 3 Agent.

## Filesystem policy

Filesystem reads are deny-by-default:

- only configured absolute canonical roots are allowed;
- `realpath` is checked before access, blocking `..` and symlink escape;
- credential/control paths such as `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, `.git`, `.hg`, `.svn`, `.env*`, private-key extensions and credential files are denied by default;
- `.env.example`, `.env.sample` and `.env.template` remain readable as non-secret templates;
- denied directory entries are omitted from `file.list` and skipped by `file.search`;
- recursive search is bounded by depth, scanned-file count and result count;
- file reads are bounded and binary/NUL-bearing reads are denied.

Git metadata is intentionally available only through typed `git.*` operations, not through direct filesystem reads of `.git`.

## Process and service policy

`process.list` reads Linux `/proc` directly, defaults to the Agent user's own processes and does not expose command-line arguments.

`service.status` accepts only explicitly allowlisted `.service` unit names and invokes fixed `systemctl --user show` arguments. The Agent reconstructs the standard per-user systemd bus location when invoked from a non-login environment, but does not gain additional privileges.

## Git policy

Git reads use fixed `git` argv with `shell: false`, bounded output/time and no external diff. Repository roots are separately allowlisted and must also be inside filesystem read roots. `git.diff` path filters reject absolute/traversal/option-like paths.

## Command runner

There is no generic command operation. The internal read-only subprocess runner accepts only `git` and `systemctl`, uses fixed structured argv, a restricted environment, one combined stdout+stderr output budget and a hard timeout.

## Session RPC

Gateway exposes an in-process `request()` API only. It validates:

1. Commander protocol contract;
2. READ authority;
3. online authenticated device/session;
4. advertised capability/version;
5. unique request ID and timeout.

Agent validates the request again before dispatch. Operation results are contract-validated and correlated to the same device/session/request/operation before Gateway resolves the caller.

## Audit

Successful and denied read operations emit structured audit events containing request ID, operation, result and safe error code. Request parameters and file contents are not written to audit fields.

## Consequences

- Phase 3 provides useful remote observability without WRITE/ADMIN authority.
- Generic shell remains absent.
- Filesystem and Git trust boundaries remain separate.
- A future Phase 4 execution engine must not reuse this synchronous read RPC for long-running commands.
- Production/private-network exposure remains deferred to later pilot phases.
