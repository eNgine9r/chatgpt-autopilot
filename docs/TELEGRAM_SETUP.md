# Telegram phone notifications

Autopilot uses Telegram only for outbound notifications. It does not accept Telegram commands.

## Secure setup

On the Raspberry Pi, from the Autopilot directory:

```bash
npm run telegram:setup
```

The command:

1. asks for the bot token using hidden terminal input;
2. verifies the bot with Telegram `getMe`;
3. asks you to open the bot and send `/start` when needed;
4. discovers the newest private chat from `getUpdates`;
5. stores `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` only in local gitignored `.env`;
6. enforces `.env` mode `0600`;
7. sends one test notification.

The token is never printed or written to project logs.

After a successful test, reload the running supervisor:

```bash
systemctl --user restart chatgpt-project-autopilot
curl -fsS http://127.0.0.1:8765/health
```

The health response should show `"telegram":true`.

## Creating a bot

Create a dedicated bot through Telegram's official BotFather. Do not reuse product-runtime secrets unless that sharing was explicitly approved.

Never paste the bot token into GitHub, source files, issues, pull requests, chat transcripts or logs.
