export class TelegramNotifier {
  constructor({ token, chatId, logger }) {
    this.token = token;
    this.chatId = chatId;
    this.logger = logger;
  }

  get enabled() {
    return Boolean(this.token && this.chatId);
  }

  async send(text) {
    if (!this.enabled) return false;

    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          disable_web_page_preview: true
        })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Telegram HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
      return true;
    } catch (error) {
      this.logger.error("telegram_send_failed", { error: String(error) });
      return false;
    }
  }
}
