# ChatGPT Autopilot Engineering Rules

This repository is a standalone development supervisor. It must remain isolated from product runtime code and secrets.

## Control surfaces

- Browser/MV3 automation remains a supported fallback backend.
- Issue #27 explicitly authorizes a Codex App Server backend and least-privilege SSH stdio transport to user-owned worker hosts.
- SSH used by Autopilot must be restricted to the Codex App Server forced command; it is not a general remote shell capability.
- Do not add Docker, Modbus, database, hardware, trading execution, or production-control capabilities unless a future explicitly scoped Issue approves them.
- Project repository writes may occur only through the configured Codex sandbox and its approval policy; Autopilot itself does not directly edit product repositories.

## Secrets

- Never commit ChatGPT credentials, browser cookies/profile data, Telegram tokens, chat IDs, private SSH keys, GitHub tokens, or production data.
- Manual browser login remains required for the browser backend.
- Local `.env`, `browser-profile/`, `state/`, `logs/`, and `config/projects.json` remain gitignored.

## Safety

- Fail closed when a backend/session cannot be recognized or authenticated.
- Never send a continuation while the active backend is still working.
- `[[USER_ACTION_REQUIRED]]` is an explicit per-project pause gate.
- Approval requests or sandbox escalation requests pause automation and notify the user.
- Do not attempt to bypass usage limits, account controls, authentication protections, or product safety gates.

## Development

- One Issue → one branch → one focused Pull Request.
- Prefer deterministic tests for backend state transitions and transport framing.
- Keep Raspberry Pi storage writes bounded and change-driven.
- Roll out backend migrations one project at a time with browser fallback available.
- Do not claim Codex/browser/Telegram acceptance until it actually runs on the target environment.
