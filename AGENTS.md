# ChatGPT Autopilot Engineering Rules

This repository is a standalone development helper. It must remain isolated from every product repository and runtime.

## Hard isolation

- Do not read, modify, clone, deploy, or control NEXOLAB, BTC Radar, Sellora, or any other project from this codebase.
- Do not add GitHub, SSH, Docker, Modbus, database, hardware, or production-control capabilities unless a future explicitly scoped Issue approves them.
- ChatGPT web UI automation is the only control surface in the MVP.

## Secrets

- Never commit ChatGPT credentials, browser cookies/profile data, Telegram tokens, chat IDs, GitHub tokens, or production data.
- Manual browser login is required; no scripted password login.
- Local `.env`, `browser-profile/`, `state/`, `logs/`, and `config/projects.json` remain gitignored.

## Safety

- Fail closed when the ChatGPT UI/session cannot be recognized.
- Never send a continuation while ChatGPT is generating.
- `[[USER_ACTION_REQUIRED]]` is an explicit per-chat pause gate.
- Do not attempt to bypass ChatGPT usage limits, account controls, or authentication protections.
- Telegram is notifications-only in the MVP; no remote command channel.

## Development

- One Issue → one branch → one focused Pull Request.
- Prefer deterministic policy tests for automation decisions.
- Keep Raspberry Pi storage writes bounded and change-driven.
- Do not claim Raspberry Pi/browser/Telegram acceptance until it actually runs on the target environment.
