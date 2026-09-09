# Commander Phase 3 acceptance evidence

Date: 2026-09-09
Issue: #185
Environment: `btc-radar` Raspberry Pi, isolated Git worktree, loopback-only ephemeral session
Production changes: none

## Automated Commander validation

- Phase 1/2/3 Commander tests: PASS before repository-wide regression.
- Policy traversal/outside-root denial: PASS.
- Symlink escape denial: PASS.
- Secret/control path denial: PASS.
- `.env.example` template access: PASS.
- Generic shell command rejection: PASS.
- WRITE operation Gateway rejection: PASS.
- Authenticated Gateway -> Agent READ routing: PASS.
- Missing capability rejection: PASS.
- Fixed-command output budget: PASS.

## Raspberry shadow acceptance

An ephemeral authenticated Agent/Gateway pair was started in-memory on a random loopback port. No systemd unit, Funnel route, production config, persistent credential or production service was changed.

Observed results:

- listener host: `127.0.0.1`;
- Agent online: PASS;
- `device.health`: PASS;
- `file.read`: PASS;
- `file.list`: PASS;
- `.git` hidden from file listing: PASS;
- `file.search`: PASS;
- `process.list`: PASS;
- process command line not exposed: PASS;
- `service.status` for `chatgpt-autopilot-v3.service`: PASS (`active`);
- `git.status`: PASS;
- `git.diff`: PASS;
- `git.log`: PASS;
- direct `.git` filesystem access: denied with `READ_POLICY_SECRET_PATH_DENIED`;
- `file.write` routed through Gateway: denied with `gateway_read_only`;
- structured successful READ audit events observed: 9;
- Agent graceful stop: PASS;
- Gateway graceful stop: PASS.

## Runtime note

Remote Desktop Commander launches commands without `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`. The fixed read-command runner now reconstructs the standard current-user bus paths (`/run/user/<uid>` and its `bus`) only when those variables are absent. This restored `systemctl --user show` without sudo or privilege expansion.

## Acceptance conclusion

Phase 3 read-only capability implementation is suitable for merge after full repository CI/regression passes. It is not a production cutover and does not authorize Phase 4 WRITE/execution capabilities.
