# Commander Phase 5 Acceptance

Issue: #187 — Controlled Write Capabilities & Policy Enforcement.

## Local gates

- Commander tests: 70/70 PASS.
- Full Node tests: 359/359 PASS.
- Browserless tests: 157/157 PASS.
- `npm run check:commander`, `npm run check`, and Browserless syntax checks: PASS.
- `git diff --check`: PASS.

## Security evidence

- `COMMANDER_WRITE_ENABLED=false` and `COMMANDER_ADMIN_ENABLED=false` are staged for both Agent and Gateway.
- Phase 5 startup rejects ADMIN enablement.
- Default systemd sandbox remains `ProtectSystem=strict` and `ProtectHome=read-only`; no project write paths are staged.
- Controlled write capabilities exclude `process.terminate` and all `system.*` ADMIN operations.
- Generic shell, sudo/root execution, Docker, trading, Modbus/hardware and production-control authority remain absent.
- Filesystem policy blocks outside-root paths, secret-like paths, final symlinks and non-UTF8 edit input.
- Approval-required policy returns `REQUIRES_APPROVAL` before mutation when no verifier is wired.
- Concurrent and reconnect replay tests prove idempotency without duplicate mutation.
- Git protected branches and remote URL mismatch fail before mutation.
- Git commit plumbing bypasses repo clean filters and hooks; push bypasses `pre-push` hooks.

## Raspberry disposable shadow acceptance

Executed only under a temporary `/tmp` root on the `btc-radar` Raspberry. No production service, repository, Funnel, product runtime or persistent Commander service was changed.

Observed:

- listener: `127.0.0.1` only;
- authenticated Agent state: online;
- `file.write`: PASS;
- `file.edit`: PASS and expected content observed;
- `git.commit`: PASS on disposable `feature/shadow` branch;
- `git.push`: PASS to a disposable local bare remote;
- remote head exactly matched local head;
- approval-required file write: `requires_approval`, no file created;
- `.env` write: denied with `WRITE_POLICY_SECRET_PATH_DENIED`;
- Gateway restart + same idempotency key replay: PASS with no second mutation;
- ADMIN capability advertised: false;
- Agent/Gateway graceful stop: PASS.

## Rollout decision

Phase 5 implementation acceptance does **not** authorize enabling writes on production hosts or product repositories. Remote Desktop Commander remains the operational fallback. Writable systemd paths, approval-verifier integration and any production pilot remain later explicit rollout gates.
