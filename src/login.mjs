import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { loadDotEnv } from "./env.mjs";
import { loadRuntimeConfig } from "./config.mjs";

loadDotEnv();
const config = loadRuntimeConfig();
fs.mkdirSync(config.browserProfileDir, { recursive: true, mode: 0o700 });

if (!fs.existsSync(config.chromiumExecutablePath)) {
  throw new Error(`Chromium executable not found: ${config.chromiumExecutablePath}`);
}

console.log("Opening ordinary Chromium with the dedicated Autopilot profile.");
console.log("Log in to ChatGPT manually. No password is handled by this program.");
console.log("Close that Chromium window after the normal authenticated ChatGPT UI is visible.");

const child = spawn(config.chromiumExecutablePath, [
  `--user-data-dir=${config.browserProfileDir}`,
  "--no-first-run",
  "--new-window",
  "https://chatgpt.com/"
], {
  env: {
    ...process.env,
    DISPLAY: config.display,
    ...(config.xauthority ? { XAUTHORITY: config.xauthority } : {})
  },
  stdio: "inherit"
});

const [code, signal] = await once(child, "exit");
if (code !== 0 && signal == null) process.exit(code || 1);
console.log("Chromium closed. Dedicated browser profile remains on disk.");
