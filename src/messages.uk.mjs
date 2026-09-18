export const TELEGRAM_TEST_MESSAGE = "✅ ChatGPT Автопілот: сповіщення Telegram працюють.";

export const TELEGRAM_BOT_PROFILE_UK = Object.freeze({
  name: "Центр керування проєктами",
  shortDescription: "Commander, Автопілот і стан Raspberry Pi в одному захищеному центрі керування.",
  description: "Захищений Telegram-центр для власника: стан Commander і підключених Raspberry Pi, журнал останніх команд, Автопілот та його проєкти, системні сервіси й сповіщення. Керування ізольоване від торгових і апаратних дій."
});

export function telegramEventMessage(project, event) {
  switch (event) {
    case "USER_ACTION_REQUIRED":
      return `⚠️ ${project.name}: потрібна ваша дія.\nАвтопродовження призупинено.\nВідкрийте чат і виконайте запитану дію:\n${project.chatUrl}`;
    case "SESSION_ATTENTION_REQUIRED":
      return `🔴 ${project.name}: сесія ChatGPT потребує уваги.\nАвтопродовження не виконує жодних дій.\nПеревірте авторизацію або стан чату:\n${project.chatUrl}`;
    case "AUTOMATION_ERROR":
      return `🔴 ${project.name}: Автопілот не може безпечно розпізнати поточний інтерфейс ChatGPT.\nАвтопродовження призупинено, щоб уникнути помилкових дій.\n${project.chatUrl}`;
    case "AUTOMATION_STALLED":
      return `🟡 ${project.name}: робота ChatGPT довго не переходить у завершений стан.\nАвтопілот не надсилає повторне «Продовжуй» і чекає безпечного завершення.\n${project.chatUrl}`;
    case "RECOVERED":
      return `🟢 ${project.name}: Автопілот відновив безпечну роботу.\nАвтопродовження знову активне.`;
    case "CONVERSATION_ROLLED_OVER":
      return `🔄 ${project.name}: попередній чат досяг максимальної довжини.\nАвтопілот створив новий чат у тому самому проєкті та продовжив роботу там.\n${project.chatUrl}`;
    case "CHAT_ADOPTED":
      return `🔗 ${project.name}: Автопілот безпечно переприв’язався до нового чату в тому самому ChatGPT Project.\nPlan Anchor і durable checkpoint збережені.\n${project.chatUrl}`;
    case "RECOVERY_FAILED":
      return `🔴 ${project.name}: автоматичне відновлення браузера вичерпало безпечні кроки.\nАвтопілот не переривав активну генерацію і не обходив auth/rate-limit/safety gates.\nПеревірте чат вручну:\n${project.chatUrl}`;
    default:
      throw new Error(`Непідтримувана подія: ${event}`);
  }
}
