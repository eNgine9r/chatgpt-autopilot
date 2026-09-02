# ChatGPT Project Autopilot

Standalone Raspberry Pi helper that keeps selected ChatGPT conversations moving without using the user's main PC.

The repository is intentionally independent from NEXOLAB, BTC Radar, Sellora and every other product repository/runtime.

## Runtime architecture

```text
systemd --user
  -> Node supervisor / loopback bridge (127.0.0.1 only)
      -> ordinary host Chromium on the Raspberry Pi desktop
          -> dedicated browser-profile/
          -> repository-owned Manifest V3 extension
              -> per-chat timer and safety policy
              -> ChatGPT web UI
      -> optional Telegram Bot API notifications
```

Production runtime does **not** use Playwright, Selenium, scripted Google login, remote shell control, GitHub control or product-runtime access.

## Behavior

- one dedicated persistent Chromium profile with a one-time manual ChatGPT login;
- multiple independently configured ChatGPT conversations;
- per-chat continuation timer, default `1480` seconds (24m40s);
- never sends while ChatGPT is generating;
- sends a configured continuation prompt only when the chat is idle and due;
- exact `[[USER_ACTION_REQUIRED]]` marker pauses only the affected chat;
- a newer user turn after the stored gate resumes that chat, including after a browser/service restart;
- duplicate tabs are protected by a per-project extension lease;
- unrecognized/empty ChatGPT state fails closed instead of guessing;
- Telegram can notify on user-action gates, session/UI errors and recovery;
- browser/session/config/log data stays local on the Raspberry Pi.

## Security boundary

The extension matches only `https://chatgpt.com/*`. The Node bridge binds only to `127.0.0.1` and accepts a fixed notification-event allowlist. Telegram credentials stay only in local `.env`; they are never exposed to the extension.

Do not commit or share `browser-profile/`, `.env`, `config/projects.json`, or local operational logs. The service does not attempt to bypass Google/OpenAI authentication, browser security challenges, account controls, rate limits or usage limits.

## Raspberry Pi requirements

- 64-bit Raspberry Pi OS / compatible ARM64 Linux desktop;
- Node.js 22+ (system install or NVM);
- ordinary Chromium installed on the host;
- an active graphical session (`DISPLAY`, normally `:0`);
- internet access to ChatGPT and, if enabled, Telegram.

## Install

```bash
git clone https://github.com/eNgine9r/chatgpt-autopilot.git
cd chatgpt-autopilot
chmod +x scripts/*.sh
./scripts/install.sh
```

The installer is unprivileged, understands NVM Node installations, creates private local `.env`, `config/projects.json`, `browser-profile/` and `logs/`, and uses the host Chromium instead of downloading a browser automation bundle.

## Configure chats

Edit local `config/projects.json`. Each entry has its own URL, interval and continuation prompt:

```json
{
  "projects": [
    {
      "id": "example-project",
      "name": "Example Project",
      "enabled": true,
      "chatUrl": "https://chatgpt.com/c/REPLACE_WITH_CHAT_ID",
      "continueAfterSeconds": 1480,
      "userGateMarker": "[[USER_ACTION_REQUIRED]]",
      "continuationPrompt": "Продовжуй роботу з фактичної поточної точки..."
    }
  ]
}
```

Use a stable `/c/<chat-id>` ChatGPT conversation URL. Actual URLs remain in gitignored local configuration.

## One-time ChatGPT login

Do not automate or store the Google/OpenAI password. Stop the user service first if it exists:

```bash
systemctl --user stop chatgpt-project-autopilot 2>/dev/null || true
npm run login
```

The command starts **ordinary host Chromium** with the dedicated `browser-profile/`. Complete Google/OpenAI login manually. When the normal ChatGPT composer is visible, close the login browser cleanly. The same authenticated profile is reused by the background runtime.

## Telegram phone alerts

Create/use a Telegram bot and put values only in local `.env`:

```text
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Test delivery:

```bash
npm run telegram:test
```

Telegram is notifications-only. There is no Telegram command, shell, GitHub or product-control channel in this release.

## Verification

Static/deterministic checks:

```bash
npm test
npm run check
bash -n scripts/install.sh scripts/install-systemd.sh
```

Recommended bounded live acceptance:

1. Configure one disposable/test conversation with `continueAfterSeconds: 60`.
2. Start `node src/index.mjs` in the foreground.
3. Verify active generation is not interrupted.
4. Verify one due continuation and a normal assistant response.
5. Have the assistant end with `[[USER_ACTION_REQUIRED]]`.
6. Verify the chat pauses and a notification event is emitted.
7. Leave it paused for another full timer interval and verify no additional continuation.
8. Reply manually, then verify the project returns to armed state.
9. Restore the normal `1480`-second interval.

## 24/7 user service

After foreground acceptance:

```bash
./scripts/install-systemd.sh
```

The installer writes only to `~/.config/systemd/user/`, resolves an exact Node.js 22+ executable (including NVM installs), enables the unit immediately, and best-effort enables `loginctl` linger for boot/logout persistence. It does not require `sudo` and does not modify another project's service.

Operations:

```bash
systemctl --user status chatgpt-project-autopilot
journalctl --user -u chatgpt-project-autopilot -f
systemctl --user restart chatgpt-project-autopilot
systemctl --user stop chatgpt-project-autopilot
```

The service restarts on failure. If linger is permitted, the user manager is scheduled at boot; Chromium itself may retry until the Raspberry Pi graphical display becomes available.

## Failure behavior

The service intentionally fails closed when it cannot safely recognize a finished assistant response, the target conversation, composer or send button. Repeated unsafe observations generate `AUTOMATION_ERROR` or `SESSION_ATTENTION_REQUIRED` instead of clicking an unknown control.

Modern ChatGPT can keep a completed response in page React state while the visible assistant node is temporarily empty after reload. The extension handles this with a bounded MAIN-world extractor that returns only text belonging to the specific assistant `data-message-id`; arbitrary page state is not forwarded to the isolated extension runtime.

## Local data

- `browser-profile/` — authenticated Chromium profile; protect like a credential;
- `config/projects.json` — enabled chat URLs/prompts;
- `.env` — host paths and optional Telegram credentials;
- `logs/autopilot.log` — supervisor/notification events;
- Chromium extension storage — per-chat timer, gate state and send count.

## Resource model

One normal Chromium process tree serves all configured chat tabs. Chromium is the dominant RAM consumer; the Node supervisor is small. Keep enabled chats bounded and measure resource use on the target Raspberry Pi before scaling concurrent tabs.
