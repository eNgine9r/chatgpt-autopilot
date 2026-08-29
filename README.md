# ChatGPT Project Autopilot

Standalone Raspberry Pi helper for keeping selected ChatGPT project conversations moving in the background.

This repository is intentionally independent from NEXOLAB, BTC Radar, Sellora, and every other product repository/runtime.

## MVP behavior

- one persistent Playwright/Chromium browser profile with manual ChatGPT login;
- multiple independently configured ChatGPT chats;
- per-chat continuation timer, default 24 minutes 40 seconds;
- never interrupts ChatGPT while a response is generating;
- sends a configured continuation prompt only when a chat is idle and due;
- detects exact `[[USER_ACTION_REQUIRED]]` and pauses only that chat;
- sends Telegram phone alerts for user-action gates, lost sessions, and repeated automation failures;
- resumes a paused chat after the user posts a newer message;
- stores only small local state/logs, not full conversations;
- supports systemd auto-start and auto-restart on Raspberry Pi.

## Safety boundary

The MVP controls only the ChatGPT web UI. It contains no GitHub, SSH, Docker, Modbus, product-database, or project-runtime control code.

Do not store ChatGPT passwords, GitHub tokens, project secrets, device credentials, or production data in this repository. ChatGPT login is performed manually once into a dedicated persistent browser profile. Telegram values live only in local `.env`.

This is UI automation. ChatGPT can change its DOM or authentication flow; on an unrecognized UI/session state the service fails closed and alerts rather than guessing what to click. It does not bypass ChatGPT usage limits or account controls.

## Raspberry Pi prerequisites

- 64-bit Raspberry Pi OS or another Playwright-supported Linux ARM64 environment;
- Node.js 22+;
- internet access for ChatGPT and optional Telegram notifications;
- enough disk space for Chromium.

Playwright officially supports ARM64 Linux Chromium, including Raspberry Pi-class environments. Browser binaries must match the installed Playwright version.

## Install

```bash
git clone git@github.com:eNgine9r/chatgpt-autopilot.git
cd chatgpt-autopilot
chmod +x scripts/*.sh
./scripts/install.sh
```

The installer creates local `.env` and `config/projects.json`, installs Node dependencies, and installs Chromium.

If Playwright reports missing Linux libraries:

```bash
sudo npx playwright install-deps chromium
npx playwright install chromium
```

## Configure chats

`config/projects.json` is local and gitignored. Start from `config/projects.example.json`.

Each project has its own URL, timer, continuation prompt, and user-gate marker. Set `enabled: true` only for chats that should be automated.

The default `1480` seconds equals 24 minutes 40 seconds.

## Telegram phone alerts

Put the bot values only in local `.env`:

```text
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Test:

```bash
node src/telegram-test.mjs
```

MVP Telegram integration is notifications-only. There is intentionally no remote command channel.

## One-time ChatGPT login

Do not put the ChatGPT password into files or scripts.

If the background service already exists, stop it first because the same persistent Chromium profile must not be opened by two browser processes:

```bash
sudo systemctl stop chatgpt-project-autopilot
npm run login
```

A visible Chromium window opens using the dedicated `browser-profile/`. Log in manually. Once the normal ChatGPT composer is visible, return to the terminal and press Enter.

Then test in the foreground:

```bash
HEADLESS=true npm start
```

## Verification

```bash
npm test
npm run check
```

Before enabling systemd, run a bounded functional test:

1. Enable one test conversation.
2. Temporarily set `continueAfterSeconds` to `60`.
3. Start the service in the foreground.
4. Verify it does not interrupt active generation.
5. Verify one continuation is sent when idle and due.
6. Make the assistant finish with `[[USER_ACTION_REQUIRED]]`.
7. Verify Telegram alert and paused state.
8. Reply manually in that ChatGPT conversation.
9. Verify it returns to armed state without sending a duplicate continuation.
10. Restore the normal interval.

## systemd

After foreground acceptance:

```bash
sudo ./scripts/install-systemd.sh
```

Useful commands:

```bash
systemctl status chatgpt-project-autopilot
journalctl -u chatgpt-project-autopilot -f
sudo systemctl restart chatgpt-project-autopilot
sudo systemctl stop chatgpt-project-autopilot
```

## Local private data

- `browser-profile/` — ChatGPT session/cookies; protect like a credential.
- `state/runtime-state.json` — small timer/status/counter state.
- `logs/autopilot.log` — automation events only; full chats are not logged.
- `.env` — optional Telegram values.
- `config/projects.json` — actual chat URLs and local project configuration.

All are gitignored. Runtime state writes are change-driven rather than every polling cycle to avoid unnecessary Raspberry Pi storage I/O.

## Resource model

One Chromium context is shared across configured project pages. Chromium is the main RAM consumer; the Node controller is small. Keep the number of simultaneously enabled chats bounded and measure on the target Pi before increasing it.

## Later work

Possible follow-ups after real Raspberry Pi acceptance:

- lightweight local status page;
- selector compatibility diagnostics;
- bounded per-chat exponential retry/backoff;
- authenticated read-only Telegram `/status` command;
- protected/encrypted browser-profile backup.
