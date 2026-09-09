# Commander Phase 4 acceptance evidence

Issue: #186
Baseline: `e6e2bae1ff58fb88ba66b5c758302d24934867a1` (Phase 3 merged main).

## Automated evidence
- Commander suite covers fixed execution policy, success/failure lifecycle, bounded stdout/stderr, stdin gating, timeout, cancel, idempotency, concurrency, process-tree termination, authenticated event streaming and reconnect replay.
- Generic shell is still absent from the operation registry.
- Execution authority remains opt-in; default Gateway is read-only.
- Installer stages `COMMANDER_EXECUTION_ENABLED=false` for Agent and Gateway.

## Raspberry Pi shadow evidence
Ephemeral loopback run on the `btc-radar` Raspberry used an in-memory session secret and fixed Node test aliases only. No systemd/Funnel/production config changed.

Observed:
- Gateway listener `127.0.0.1`;
- Agent online and authenticated;
- start returned a first-class execution id;
- Gateway restart followed by the same idempotency key returned the same execution id;
- no duplicate execution was created;
- terminal state `success`;
- buffered output contained the expected stream after reconnect;
- a separate held execution cancelled to `cancelled`;
- Phase 4 advertised no ADMIN capability;
- Agent and Gateway stopped cleanly.

## Production state
Execution remains disabled by default. Remote Desktop Commander remains the fallback. No production Commander service enablement or cutover is part of Phase 4.
