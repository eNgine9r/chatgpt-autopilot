import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDedicatedBrowserProject, buildDedicatedChromiumArgs } from "../src/dedicated-browser-launcher.mjs";

const projectId = "g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function config(chatId, overrides = {}) {
  return {
    projects: [{
      id: "autopilot-development",
      name: "Autopilot Development",
      enabled: true,
      backend: "browser",
      chatUrl: `https://chatgpt.com/g/${projectId}-autopilot/c/${chatId}`,
      continuationPrompt: "Continue safely",
      planVersion: "2026-09-04-v1",
      browserRecovery: { enabled: true, staleHeartbeatSeconds: 90, allowSessionRestart: false },
      checkpointLedger: { enabled: true },
      chatDiscovery: { enabled: true, autoAdopt: false },
      ...overrides
    }]
  };
}

function writeConfig(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}
test("dedicated browser resolves the current chat from config on every launch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-dedicated-browser-"));
  const file = path.join(root, "projects.json");
  writeConfig(file, config("old"));
  assert.match(loadDedicatedBrowserProject(file).chatUrl, /\/c\/old$/);
  writeConfig(file, config("new"));
  const current = loadDedicatedBrowserProject(file);
  assert.match(current.chatUrl, /\/c\/new$/);

  const args = buildDedicatedChromiumArgs({
    project: current,
    appDir: "/srv/autopilot",
    profileDir: "/srv/autopilot/profile",
    runtimeConfig: { chromiumOzonePlatform: "wayland" }
  });
  assert.equal(args.at(-1), current.chatUrl);
  assert.match(args.join(" "), /--load-extension=\/srv\/autopilot\/extension/);
});

test("dedicated browser rejects a configured chat outside its project root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-dedicated-browser-"));
  const file = path.join(root, "projects.json");
  writeConfig(file, config("chat", { projectRootUrl: "https://chatgpt.com/g/g-p-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/project" }));
  assert.throws(() => loadDedicatedBrowserProject(file), /dedicated_chat_must_match_project_root/);
});
