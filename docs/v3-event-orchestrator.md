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

`POST /github` is an authenticated GitHub ingress on the same loopback-only listener. It requires an HMAC-SHA256 webhook secret; public exposure and GitHub hook creation remain separate rollout steps.

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

The installer generates and preserves a private 32-byte webhook secret under `state-v3/` and injects only its file path into the disabled v3 user service. The listener still binds only to `127.0.0.1`; exposing `/github` and creating repository webhooks are separate acceptance steps.