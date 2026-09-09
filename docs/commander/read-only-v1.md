# Commander read-only capabilities v1

Status: Phase 3 implementation contract
Tracking issue: #185

## Operations

| Operation | Purpose | Primary bounds |
| --- | --- | --- |
| `device.health` | Host/runtime summary | no arbitrary parameters |
| `file.read` | Read an allowlisted text file | max 64 KiB |
| `file.list` | List visible entries | max 200 entries |
| `file.info` | File metadata | allowlisted canonical path |
| `file.search` | Literal name/content search | depth <= 8, results <= 100, scanned files <= 1000 |
| `process.list` | Agent-user process metadata | max 256, no cmdline |
| `service.status` | Allowlisted user service status | fixed `systemctl --user show` |
| `git.status` | Repository status | allowlisted repository, bounded output |
| `git.diff` | Working/staged diff | max 64 KiB, safe path filters |
| `git.log` | Recent commit metadata | max 50 commits |

## Policy file

The Agent loads a JSON policy such as:

```json
{
  "version": 1,
  "roots": ["/home/user/project"],
  "repositories": ["/home/user/project"],
  "services": ["my-user-service.service"]
}
```

An empty policy is valid and fail-closed for filesystem, repository and service access. The staged installer creates an empty policy and still leaves `COMMANDER_ENABLED=false`.

## Security invariants

- no `shell.exec`;
- no WRITE/ADMIN operation is advertised or routed;
- no sudo;
- no public listener beyond the existing loopback-only Phase 2 Gateway;
- no raw process command line in `process.list`;
- no direct `.git` or credential-path reads;
- no caller-supplied executable or arbitrary command arguments;
- every request/result is protocol-validated and correlated to the authenticated session;
- command and filesystem output are bounded.

## Error behavior

Expected denials return structured `OperationResult` errors, for example:

- `READ_POLICY_PATH_OUTSIDE_ROOTS`;
- `READ_POLICY_SECRET_PATH_DENIED`;
- `READ_POLICY_REPOSITORY_NOT_ALLOWED`;
- `READ_POLICY_SERVICE_NOT_ALLOWED`;
- `READ_OPERATION_AUTHORITY_DENIED`;
- `READ_REQUEST_DEADLINE_EXPIRED`.

Gateway rejects WRITE/ADMIN operations before transmission with `gateway_read_only`.
