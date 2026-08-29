import { chromium } from "playwright";

const SELECTORS = {
  stop: [
    'button[data-testid="stop-button"]',
    "#composer-stop-button",
    'button[aria-label*="Stop"]',
    'button[title*="Stop"]',
    'button[aria-label*="Зупин"]',
    'button[title*="Зупин"]'
  ],
  composer: [
    "#prompt-textarea",
    'textarea[data-testid="prompt-textarea"]',
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="Повідом"]',
    'div.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"][data-lexical-editor="true"]'
  ],
  send: [
    "#composer-submit-button",
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label*="Надісл"]'
  ]
};

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 150 })) return locator;
    } catch {}
  }
  return null;
}

export async function launchBrowser(profileDir, headless) {
  return chromium.launchPersistentContext(profileDir, {
    headless,
    channel: "chromium",
    viewport: { width: 1280, height: 900 },
    locale: "uk-UA"
  });
}

export async function openProjectPage(context, project) {
  const page = await context.newPage();
  await page.goto(project.chatUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  return page;
}

export async function isGenerating(page) {
  return Boolean(await firstVisible(page, SELECTORS.stop));
}

export async function readLatestTurn(page) {
  return page.evaluate(() => {
    const turns = [...document.querySelectorAll(
      '[data-message-author-role="assistant"], [data-message-author-role="user"]'
    )];
    if (!turns.length) return { role: "unknown", text: "" };
    const node = turns[turns.length - 1];
    return {
      role: node.getAttribute("data-message-author-role") || "unknown",
      text: (node.innerText || "").trim()
    };
  });
}

export async function isAuthenticatedConversation(page) {
  const composer = await firstVisible(page, SELECTORS.composer);
  return Boolean(composer);
}

export async function sendPrompt(page, prompt) {
  const composer = await firstVisible(page, SELECTORS.composer);
  if (!composer) throw new Error("ChatGPT composer not found");

  await composer.click();
  await composer.fill(prompt).catch(async () => {
    await page.evaluate(({ selectors, text }) => {
      const editor = selectors.map((selector) => document.querySelector(selector)).find(Boolean);
      if (!editor) throw new Error("composer not found");
      editor.focus();
      if ("value" in editor) editor.value = text;
      else editor.textContent = text;
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      }));
    }, { selectors: SELECTORS.composer, text: prompt });
  });

  await page.waitForTimeout(400);
  const send = await firstVisible(page, SELECTORS.send);
  if (!send) throw new Error("ChatGPT send button not found");
  if (await send.isDisabled()) throw new Error("ChatGPT send button is disabled");
  await send.click();
}
