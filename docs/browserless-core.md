# Browserless Autopilot Core

## Goal
Make Chromium optional. Healthy idle state performs zero ChatGPT page loads and zero OpenAI API calls.

## Runtime
- Python standard library only.
- SQLite WAL durable state.
- Event-driven queue with idempotency keys and per-project serialization.
- OpenAI Responses API model is fixed to `gpt-5.6-luna` in v1.
- No silent model escalation.
- Missing credential, budget exhaustion, malformed model output, or ambiguous evidence fail closed.

## Context contract
Only the governed Plan Anchor, compact durable checkpoint, bounded event summary/metadata, and bounded fresh evidence are sent. Full chat history and raw logs are deliberately excluded.

## Cost control
Every call has a conservative preflight against a configurable monthly hard budget. Usage tokens returned by the Responses API are recorded durably for spend estimation. No event means no request and therefore no tokens.

## Safety
Browser fallback remains disabled during Browserless development. Autopilot must not perform product trading, hardware/Modbus writes, or unapproved production/site cutovers.

## Legacy continuity import
Use `python3 -m src.browserless.import_legacy` to copy only governed Plan Anchors and durable checkpoints from the legacy private project config/state files into a Browserless SQLite database. The importer deliberately does not enqueue AI work and ignores legacy ChatGPT URLs, browser telemetry, raw conversations, and Codex-shadow projects without a Plan Anchor. Re-running the importer updates the governed anchor but never overwrites a newer Browserless checkpoint.

After a database has imported projects, `src.browserless.daemon` can run without `--config`; the SQLite store becomes the durable continuity source.


## Observation ingress
Browserless Core does not poll ChatGPT. `src.browserless.observe` accepts compact read-only GitHub or runtime snapshots, normalizes only allowlisted material fields, and records a content hash per project/source/subject. Volatile timestamps and runtime CPU/RAM/uptime metrics do not change the hash. An unchanged observation creates no new event or job, so it cannot consume Luna tokens.

GitHub normalizers support workflow runs, pull requests, issues, and issue comments. Comment bodies are represented by a SHA-256 identity rather than copied automatically into the AI context. Runtime observations accept stable health/version/mode/flag/blocker fields; raw errors/logs are ignored and only explicitly supplied `safe_evidence` may be forwarded.

Example producer call: `python3 -m src.browserless.observe --db <db> --project-id <id> --source runtime --input snapshot.json`. The observation producer may run from a webhook, a local service, or another low-cost event source; the Browserless core remains transport-independent.

## Read-only action contract
Luna v1 structured output can request only `github.read`, `runtime.read`, `git.read`, or `evidence.read`. Such requests are durably stored as `planned` action requests for audit but are not executed by this phase. Browser, write, restart, trading, hardware, Modbus, secret, and production-cutover actions are absent from the schema and fail closed. Non-`continue` decisions cannot leave queued actions.


## Authenticated event transport
`src.browserless.ingress_server` is a lightweight stdlib HTTP receiver that binds to loopback only. It accepts project-specific GitHub webhook and runtime event paths, verifies HMAC-SHA256 before parsing the payload, enforces exact GitHub repository bindings and runtime component allowlists, then records the normalized observation. The HTTP handler never calls Luna and never creates jobs directly.

Bindings live in a non-secret JSON file (`config/browserless-ingress.example.json`). Each project binding names an environment variable that contains its own secret; secret values are never stored in the bindings document. A missing secret fails closed at startup. Public/Tailscale/reverse-proxy exposure is intentionally outside this phase and requires a separate production activation decision.

GitHub endpoint: `POST /v1/github/<project-id>` with `X-Hub-Signature-256` and `X-GitHub-Event`. Runtime endpoint: `POST /v1/runtime/<project-id>` with `X-Autopilot-Signature-256`. `GET /health` is read-only. Request bodies are capped at 256 KiB.
