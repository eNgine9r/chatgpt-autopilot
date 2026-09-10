# Autopilot v3: deterministic event-driven orchestrator

Autopilot v3 removes the LLM from routine orchestration. The core consumes events, persists state, and emits the next configured action deterministically.

## Design goals

- zero OpenAI API calls on routine paths;
- no Chromium or ChatGPT web session in the critical path;
- event-driven rather than polling-driven control;
- durable restart-safe state;
- bounded idempotency for repeated webhook/events;
- explicit user approval steps;
- no trading, hardware/Modbus, secret disclosure, merge, deploy, or production cutover capability in the foundation.

## State flow

`idle -> ready -> running -> ready ... -> waiting_approval -> ready -> complete`

Failures move `running -> blocked`. A deterministic `retry` returns to the current step. `pause` / `resume` are persisted. Duplicate event IDs are ignored.

## Local API

The foundation server binds to `127.0.0.1:8780` by default.

- `GET /health` reports v3 mode and `aiCalls: 0`.
- `GET /projects` reads durable local project state.
- `POST /events` accepts a bounded JSON event and returns the resulting state plus an optional deterministic dispatch.

`POST /github` is isolated on a second loopback-only listener (default `127.0.0.1:8781`). The local control plane stays on `127.0.0.1:8780` and does not expose `/github`; the GitHub listener does not expose `/events` or `/projects`. A valid HMAC-SHA256 webhook secret is required before the GitHub listener starts.

## Project configuration

Each project has an ordered list of steps. A step contains an ID, an action name, optional parameters, and optional `approval: "user"`.

The deterministic engine executes only allowlisted local read/test actions. Mutating repository, GitHub, deployment, trading and hardware actions remain outside the v3 capability set.

## Example event

```json
{"id":"evt-1","projectId":"btc-radar-development","kind":"task.received","taskId":"issue-123"}
```

The response can contain:

```json
{"dispatch":{"projectId":"btc-radar-development","stepId":"inspect","action":"repo.inspect","params":{}}}
```

No model prompt, token, or OpenAI credential is involved.

## Service rollout

`npm run install:v3-service` installs a user service and a local config copy but deliberately does not enable or start it. Runtime enablement is a separate acceptance/cutover decision.

## Deterministic executor

The v3 execution engine may automatically drain consecutive safe actions after one external event. No model decision is inserted between routine steps.

Supported executor actions are intentionally narrow:

- `repo.inspect` runs fixed read-only Git metadata commands;
- `repo.test` runs only a named private config alias using `execFile` with `shell:false`;
- `operator.review` is a no-op acknowledgement after the explicit state-machine approval gate.

Test executables are allowlisted, arguments come only from the private local project config, output/time are bounded, and the child environment excludes unrelated Autopilot secrets. Unsupported actions fail closed into a durable blocked state.

## GitHub webhook adapter

Projects may bind exactly one GitHub repository plus one or more explicit task labels. Only signed `issues` events with an accepted action and a configured task label are translated into `task.received` events.

The adapter verifies `X-Hub-Signature-256` against the exact raw request body and uses `X-GitHub-Delivery` as the durable event ID. Cross-repository, unsigned, tampered, unlabelled and unsupported events fail closed or are ignored without running project actions.

The installer generates and preserves a private 32-byte webhook secret under `state-v3/` and injects only its file path into the disabled v3 user service. Both listeners bind only to `127.0.0.1`; exposing the dedicated GitHub port and creating repository webhooks are separate acceptance steps.
## Restricted SSH gateway transport

A project may use `transport.type: "ssh-gateway"` instead of a local `repoPath`. This keeps the central v3 orchestrator on one Raspberry while executing only fixed read/test operations on another host.

The central executor invokes `ssh` with `BatchMode=yes`, `IdentitiesOnly=yes`, `StrictHostKeyChecking=yes`, a configured identity file, and a fixed operation (`inspect` or `test <alias>`). No command text comes from GitHub events or task payloads.

The remote identity must be a dedicated key whose `authorized_keys` entry forces `scripts/v3-remote-gateway.py`. The existing Codex key or any unrestricted shell key must not be reused. The gateway reads a private local config, maps test aliases to allowlisted argv, runs with `shell=False`, sanitizes the child environment, bounds output/time, and rejects all other `SSH_ORIGINAL_COMMAND` values.

A host without Node.js can run the gateway with Python 3 only. `config/v3-remote.example.json` shows the remote config shape. Installing the forced-command key and enabling remote project routing are separate shadow acceptance steps.
## Reversible production webhook cutover

`scripts/v3-webhook-cutover.py` is dry-run by default. It reads current Funnel, GitHub hook and label state, then reports the exact parallel v3 operations without mutating anything. `--apply` is the explicit production mutation gate.

The cutover adds a separate `/autopilot-v3-github` Funnel path to the dedicated `127.0.0.1:8781/github` listener, creates or updates one callback hook per configured repository with `issues` events only, creates missing task labels, and enables the v3 service. Existing Browserless `/autopilot-events` hooks are never modified.

Rollback is also dry-run unless combined with `--apply --rollback`. It removes only hooks using the v3 callback URL, removes only the v3 Funnel path, and disables v3; it does not require or modify the legacy webhook secrets.

## Telegram operator bridge

The v3 Telegram bridge is a separate companion process. The deterministic core never receives the Telegram bot token and the bridge exposes no inbound listener.

The companion reads `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `TELEGRAM_OWNER_USER_ID` from the existing private `.env`, polls Telegram Bot API, and talks only to the local `127.0.0.1:8780` control plane.

Supported commands are `/v3` or `/status`, `/approve <project-id>`, and `/retry <project-id>`. Approval and retry are state-gated; commands from any other user or chat are ignored. The bridge persists the Bot API update offset and notification fingerprints in mode-600 `state-v3/telegram.json`.

Notifications are deduplicated and emitted for `waiting_approval`, `blocked`, and subsequent completion transitions. Initial already-complete states are baselined without startup spam.

`bash scripts/install-v3-telegram-systemd.sh` stages `chatgpt-autopilot-v3-telegram.service` but deliberately does not enable or start it. Live Telegram activation remains a separate production acceptance decision.


## Optional Commander execution backend

Phase 7 adds an optional Commander backend without replacing the deterministic v3 orchestrator or its existing local/restricted-SSH executor. Commander routing requires both `COMMANDER_ENABLED=true` and an explicit `project.commander.enabled=true` block. Existing project transport remains valid fallback configuration.

For Commander-selected projects, `repo.inspect` consumes structured `git.status` and `git.log` results, while `repo.test` uses the fixed-alias Commander execution lifecycle. Failures are persisted as bounded classified `lastFailure` metadata. An ambiguous Commander transport failure blocks the step and reuses the same mutation attempt on retry; a known terminal failure advances the attempt. No automatic local/SSH fallback occurs after an in-flight Commander failure because that could duplicate work whose response was lost.
