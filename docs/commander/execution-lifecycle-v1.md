# Commander Execution Lifecycle v1

Phase 4 implements `execution.start`, `execution.get`, `execution.output`, `execution.input`, and `execution.cancel`.

## Execution policy
Each alias fixes:
- absolute executable;
- complete argv;
- absolute working directory;
- maximum timeout;
- whether bounded stdin is accepted.

Remote callers select only the alias. They cannot provide executable paths, shell fragments, environment variables, cwd, or additional argv. Child environment is sanitized and `shell:false` is mandatory.

## Lifecycle
States are `queued`, `running`, `success`, `failed`, `cancelled`, and `timeout` for Phase 4 owned processes. Output is bounded to at most 64 KiB retained stdout+stderr and at most 256 retained events. `totalBytes` records observed output even when retention truncates.

Mutating requests require idempotency keys. A replay with the same operation/device/params returns the prior semantic result using the new transport request id. Reusing a key with different parameters fails closed.

## Streaming and reconnect
The Agent emits validated `ExecutionEvent` frames while online. The Gateway keeps a bounded recent event cache and emits `executionEvent` locally. The Agent remains source of truth: `execution.output` recovers buffered events after a network gap. A Gateway disconnect never restarts an owned execution.

## Termination
Timeout and cancel signal the owned process group, then use a bounded SIGKILL fallback. Agent shutdown cancels active executions before exit.

## Default safety
`COMMANDER_EXECUTION_ENABLED=false` remains staged in both service env files. Gateway and Agent accept WRITE authority only when that flag is explicitly enabled. No ADMIN capability, sudo, package install, service mutation, Git mutation, deploy, trading, Modbus, or arbitrary `shell.exec` is introduced by Phase 4.
