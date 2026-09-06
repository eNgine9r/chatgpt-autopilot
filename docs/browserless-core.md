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
Luna v1 structured output can request only `github.read`, `runtime.read`, `git.read`, or `evidence.read`. Such requests are durably stored as `planned` action requests and are executed only by the separate allowlisted read-only executor. Browser, write, restart, trading, hardware, Modbus, secret, and production-cutover actions are absent from the schema and fail closed. Non-`continue` decisions cannot leave queued actions.


## Authenticated event transport
`src.browserless.ingress_server` is a lightweight stdlib HTTP receiver that binds to loopback only. It accepts project-specific GitHub webhook and runtime event paths, verifies HMAC-SHA256 before parsing the payload, enforces exact GitHub repository bindings and runtime component allowlists, then records the normalized observation. The HTTP handler never calls Luna and never creates jobs directly.

Bindings live in a non-secret JSON file (`config/browserless-ingress.example.json`). Each project binding names an environment variable that contains its own secret; secret values are never stored in the bindings document. A missing secret fails closed at startup. Public/Tailscale/reverse-proxy exposure is intentionally outside this phase and requires a separate production activation decision.

GitHub endpoint: `POST /v1/github/<project-id>` with `X-Hub-Signature-256` and `X-GitHub-Event`. Runtime endpoint: `POST /v1/runtime/<project-id>` with `X-Autopilot-Signature-256`. `GET /health` is read-only. Request bodies are capped at 256 KiB.


## Read-only evidence executor
`src.browserless.action_runner` consumes only previously validated `planned` read actions. The model never supplies a raw URL, filesystem root, repository, or shell command: targets resolve through `config/browserless-tools.example.json` aliases. GitHub reads use fixed REST resource shapes, runtime reads are loopback JSON GETs with redirects disabled, git reads use fixed non-mutating commands with `GIT_OPTIONAL_LOCKS=0` and `shell=False`, and evidence reads are contained under configured roots with extension/size limits and secret-key redaction.

Supported target forms are `github.read = <alias>:issue|pr|commit|run:<id>`, `runtime.read = <alias>`, `git.read = <alias>:head|branch|status|diffstat|log:<n>`, and `evidence.read = <alias>:<relative .json/.md/.txt file>`. GitHub tokens, when required for private repositories, are referenced only by optional `tokenEnv` names in the tool config.

Every read result is written back through the normal `evidence` observation hash gate. A changed result creates one evidence event for a later Luna decision; an unchanged repeated read is marked `suppressed` and creates no new AI job. The action runner itself never calls OpenAI.

## Single-process production supervisor
Production Browserless runtime is packaged as one Python process combining the Luna job loop, read-only action loop, and optional loopback ingress server. This avoids keeping three Python daemons resident. The individual CLIs remain available for diagnostics.

`bash scripts/install-browserless-systemd.sh` only stages the user-systemd unit. It deliberately does not enable or start it; production activation remains a separate cutover gate.

## GitHub event transport
Browserless production uses signed GitHub webhooks instead of Chromium polling. The ingress remains bound to `127.0.0.1:8771`; production exposure is expected through a separately approved reverse-proxy/Funnel path such as `/autopilot-events`.

GitHub sends a signed `ping` when a hook is created. Browserless validates HMAC and repository identity, returns HTTP 200, and deliberately creates no event/job for that ping.

`python3 -m src.browserless.webhook_config --bindings config/browserless-ingress.json --base-url https://HOST/autopilot-events` is dry-run by default. `--apply` is the explicit mutation gate. On apply, webhook secrets are read from a mode-600 env file and sent to `gh api` through stdin, never command arguments. Existing hooks with the exact callback URL are updated rather than duplicated.

Configured GitHub events are `workflow_run`, `pull_request`, `issues`, and `issue_comment`; each received payload still passes through content-hash deduplication before any Luna job exists.

## Checkpoint bootstrap and operator task ingress
On supervisor startup, every imported project whose governed checkpoint is still `active` and has a current task or next action receives one deterministic `bootstrap.resume` event. The idempotency key is derived only from governed checkpoint contract fields, so restarts and legacy-only revision noise do not duplicate Luna work. A material checkpoint change produces a new resume event; `stage=complete` produces none.

New manual work can be submitted without Chromium using `python3 -m src.browserless.operator --db <db> --project <id> --request-id <id>`. Task text may be supplied with `--task` or via stdin. A repeated request id is idempotent, and task text is capped before it can enter the event queue.

Before each Luna decision, the supervisor adds a bounded capability manifest for that project to `STABLE_CONTEXT`. It contains only action target grammar, configured alias names, repository test aliases, write-enabled state and bounded `writePaths`. Local filesystem paths, runtime URLs, tokens, environment names and publish repository identity are deliberately excluded.

## Isolated repository workspace actions
Browserless v1 uses repository actions only through local repository aliases: `repo.read`, `repo.prepare`, `repo.patch`, `repo.test`, `repo.commit`, and `repo.publish`. `repo.read` is limited to tracked UTF-8 files, tracked tree listings, and literal tracked-code search; sensitive filenames and untracked files are excluded. `repo.prepare` is allowed only when the local binding explicitly sets `writeEnabled=true`, resolves the current remote base-branch SHA, and creates a deterministic job worktree outside the canonical repository without moving canonical `main`.

`repo.test` never executes a model-supplied command. The model chooses only a configured test alias. Tests run inside Bubblewrap with a cleared environment, hidden `/home`, isolated network namespace, private `/tmp`, and only the isolated workspace bind-mounted writable. If Bubblewrap is unavailable, the action fails closed. `repo.patch` is the only code mutation before commit and is limited by `writePaths`. The initial policy enables repository writes only for the Autopilot repository; product repositories remain write-disabled until separately governed. Direct push, merge, auto-merge, deploy, browser, trading, and hardware/Modbus actions remain unavailable.
Workspace continuity is durable: `repo.prepare` records the active repository alias, branch, workspace path, and remote base SHA in SQLite. Later Luna turns and process restarts resolve `repo.test` against that same active workspace rather than the current AI job id. Only one workspace action is accepted per model decision, forcing a fresh evidence turn between prepare/test and any future mutating stages.

## Isolated patch contract
`repo.patch` accepts only a bounded unified diff for allowlisted tracked regular files inside the active durable workspace. New/delete/rename/binary/mode changes are rejected, patch application is checked before mutation, and any post-apply/state failure reverse-applies the patch. `repo.test` attests the exact durable diff SHA inside Bubblewrap.

## Commit and pull-request publish contract
`repo.commit` can create one local commit only when the durable workspace has a passing test attestation for the exact current diff SHA. Repository hooks, fsmonitor, interactive credential prompts, and commit signing are disabled; a durable-state failure restores the previously attested working diff.

`repo.publish` may push only the generated Browserless workspace branch to the exact configured `publishRepository` and create or reuse a pull request against the configured base branch. It never force-pushes, merges, enables auto-merge, or deploys. Repeated publish is idempotent and the confirmed commit SHA, PR number, and PR URL are persisted in SQLite.

## Required test attestations
Writable repository bindings must define at least one sandboxed test. `requiredTests` defaults to all configured test aliases; an explicit non-empty subset may be used when the repository policy requires it. Each test result is stored durably by test alias and exact `diff_sha`.

`repo.commit` and `repo.publish` fail closed until every required test alias has `passed=true` for the current durable diff SHA. A later PASS from one test never replaces or hides a failed/missing different required test. Applying any new patch clears the entire attestation set, so all required tests must be rerun for the new diff. The Luna capability manifest exposes only the safe `requiredTestAliases` names.

## Action failure circuit breaker
Failed actions are not treated like unchanged successful reads. The first failure emits retry evidence; the second failure for the same action in the current workspace session marks `retry_exhausted=true`. A successful same action resets that workspace-local failure streak. Luna must not request the same exhausted action again. If it does, Browserless blocks the job as `repeated_action_failure` instead of silently idling or executing another retry.

Patch apply failures keep the stable error code `repo_patch_apply_failed` and may include only a bounded machine-safe `error_detail`: `hunk_mismatch`, `corrupt_patch`, `whitespace_error`, `apply_check_failed`, or `apply_after_check_failed`. Raw git stderr, local filesystem paths, and arbitrary error text are never forwarded into Luna context. For `hunk_mismatch`, Luna should re-read the exact tracked file before regenerating the patch.

`repo.patch` payloads must be raw git-style unified diffs beginning with `diff --git a/<path> b/<path>` and containing matching `--- a/<path>` / `+++ b/<path>` headers. Markdown fences are not valid patch payload.

## Structured-action production contract
Only `repo.patch` may carry a non-empty action `payload`; every other safe action must use exactly `payload=""` and place human-readable intent in `purpose`. The validator remains fail-closed on any non-patch payload. If an OpenAI response is received but rejected by structured validation, its returned token usage is still recorded in the durable cost ledger before the job is blocked, so invalid model output cannot bypass the budget governor.

## Private GitHub read authentication
A GitHub read binding may use either `tokenEnv` or `useGhAuth: true`; the two modes are mutually exclusive. `useGhAuth` reuses the local GitHub CLI credential store without copying a token into Browserless configuration or environment files. Browserless invokes only fixed `gh api --hostname github.com --method GET repos/<configured-repository>/<allowlisted-resource>` commands with `shell=False`, prompts disabled, and a minimal subprocess environment that excludes OpenAI/webhook secrets. Returned issue bodies are not forwarded to Luna; only a SHA-256 body hash and bounded metadata are retained.

## GitHub event coalescing
Production supervisor debounces only GitHub observations. Signed `workflow_run` webhooks whose status is `queued` or `in_progress` are acknowledged with HTTP 200 but do not create an observation/event; the terminal `completed` transition remains material. Pending GitHub observations wait for a 15-second per-project quiet window. At release, only the latest revision of each observation subject is retained, and multiple distinct subjects are packed into bounded `observation.github.batch` events (maximum 16 changes per batch). This keeps issue comments and distinct issue/PR/workflow subjects while collapsing lifecycle revisions. Operator tasks, bootstrap events, runtime/evidence events, and action evidence are never delayed by the GitHub quiet window.

## Pull-request changed-file reads
`github.read` supports `<github-alias>:prfiles:<number>` for bounded changed-file context. It returns at most 100 non-sensitive filenames with status/addition/deletion/change counts and optional safe previous filenames. GitHub patch text, raw file content, object SHAs, issue bodies, and credentials are not exposed. For private repositories, the same local `gh` credential-store transport is used without extracting or duplicating the token. Luna should use `prfiles` to choose a tracked file, then use `repo.read` for bounded file content when needed.
## Unchanged-read continuation
When a safe read returns the same authoritative result as its prior observation, the action remains `suppressed`, but Browserless emits one compact suppression evidence revision for that exact action type/target/result hash. This wakes the decision loop once without duplicating the underlying result. Repeating the same unchanged state produces no further suppression event. If Luna ignores `suppressed_unchanged=true` and requests the same action type/target again, the job is blocked as `repeated_suppressed_action` before another external read. A distinct next read, wait, completion, or escalation remains allowed.
## Bounded reads for large tracked files
Full `repo.read <alias>:file:<path>` remains limited to 64 KiB. If a tracked text file exceeds that bound, Browserless returns `repo_file_too_large`; Luna must use literal `repo.search` to locate material symbols or line numbers, then request `repo.read <alias>:lines:<start>:<count>:<path>`. Ranged reads allow at most 200 lines per action and source files up to 1 MiB, while preserving tracked-path and sensitive-file protections.

## Ranged-read budget
Bounded `repo.read ...:lines:...` windows are for targeted inspection, not sequential whole-file scans. Browserless permits at most six consecutive ranged windows for the same file within 15 minutes. The next range is rejected before external file access with `repo_ranged_read_budget_exhausted` and bounded evidence. Luna must then wait, complete, escalate, or select a distinct artifact; requesting another ranged window for the blocked file is rejected by the core before action planning. A distinct action or expiry of the 15-minute window resets the consecutive-read streak.
## Exact ranged-read reuse and workflow run identity
Repeated `repo.read ...:lines:...` requests for the exact same target within 60 seconds reuse the already stored successful result instead of touching the filesystem again. The reused local result is marked only in local action state, does not add another ranged-read budget window, and produces the normal unchanged-evidence suppression semantics for Luna. After the cooldown expires, the target is read normally again.

For GitHub `workflow_run` observations, Browserless preserves the webhook `runId` through quiet-window batching. `github.read <alias>:run:<identity>` must use that numeric `runId`; a workflow ID embedded in the observation subject and `run_number` are not valid substitutes.
