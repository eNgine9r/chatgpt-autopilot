import fs from "node:fs";
import { loadDotEnv } from "./env.mjs";
import { loadRuntimeConfig, loadProjects } from "./config.mjs";
import { launchBrowser } from "./browser.mjs";

loadDotEnv();
const config = loadRuntimeConfig();

const firstUrl = fs.existsSync(config.projectsFile)
  ? loadProjects(config.projectsFile)[0]?.chatUrl
  : "https://chatgpt.com/";

const context = await launchBrowser(config.browserProfileDir, false);
const page = await context.newPage();
await page.goto(firstUrl || "https://chatgpt.com/", { waitUntil: "domcontentloaded" });

console.log("");
console.log("A Chromium window is open using the dedicated standalone browser profile.");
console.log("Log in to ChatGPT manually. Do NOT put your password into project files.");
console.log("After login succeeds and the normal ChatGPT composer is visible, return here and press Enter.");

process.stdin.resume();
await new Promise((resolve) => process.stdin.once("data", resolve));
await context.close();
console.log("Browser profile saved.");
