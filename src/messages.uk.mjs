export const TELEGRAM_TEST_MESSAGE = "✅ ChatGPT Autopilot: сповіщення Telegram працюють.";

export const TELEGRAM_BOT_PROFILE_UK = Object.freeze({
  name: "Autopilot — помічник розробки",
  shortDescription: "Автоматично продовжує роботу в ChatGPT та сповіщає, коли потрібна ваша дія.",
  description: "Autopilot працює у фоновому режимі на Raspberry Pi, автоматично продовжує вибрані чати ChatGPT і надсилає сповіщення, коли потрібне ваше втручання. Бот використовується лише для сповіщень і не виконує віддалених команд."
});

export function telegramEventMessage(project, event) {
  switch (event) {
    case "USER_ACTION_REQUIRED":
      return `⚠️ ${project.name}: потрібна ваша дія.\nАвтопродовження призупинено.\nВідкрийте чат і виконайте запитану дію:\n${project.chatUrl}`;
    case "SESSION_ATTENTION_REQUIRED":
      return `🔴 ${project.name}: сесія ChatGPT потребує уваги.\nАвтопродовження не виконує жодних дій.\nПеревірте авторизацію або стан чату:\n${project.chatUrl}`;
    case "AUTOMATION_ERROR":
      return `🔴 ${project.name}: Autopilot не може безпечно розпізнати поточний інтерфейс ChatGPT.\nАвтопродовження призупинено, щоб уникнути помилкових дій.\n${project.chatUrl}`;
    case "RECOVERED":
      return `🟢 ${project.name}: Autopilot відновив безпечну роботу.\nАвтопродовження знову активне.`;
    default:
      throw new Error(`Непідтримувана подія: ${event}`);
  }
}
