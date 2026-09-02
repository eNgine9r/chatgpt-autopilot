import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadProjects,
  normalizeChatUrl,
  publicProjects,
  deriveProjectRootUrl,
  sameProjectChatUrl
} from "../src/config.mjs";

function tempConfig(projects) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-config-"));
  const file = path.join(dir, "projects.json");
  fs.writeFileSync(file, JSON.stringify({ projects }));
  return file;
}

const project = {
  id: "demo",
  name: "Demo",
  enabled: true,
  chatUrl: "https://chatgpt.com/c/abc/",
  continueAfterSeconds: 60,
  userGateMarker: "[[USER_ACTION_REQUIRED]]",
  continuationPrompt: "Continue safely"
};

const projectChat = "https://chatgpt.com/g/g-p-demo123/c/chat456";

test("loads and normalizes valid ChatGPT project", () => {
  const loaded = loadProjects(tempConfig([project]));
  assert.equal(loaded[0].chatUrl, "https://chatgpt.com/c/abc");
  assert.equal(publicProjects(loaded).length, 1);
});

test("supports one-time immediate start without changing recurrence", () => {
  const loaded = loadProjects(tempConfig([{ ...project, startImmediately: true, continueAfterSeconds: 1620 }]));
  assert.equal(loaded[0].startImmediately, true);
  assert.equal(loaded[0].continueAfterSeconds, 1620);
});

test("derives and validates ChatGPT Project root for rollover", () => {
  const root = deriveProjectRootUrl(projectChat);
  assert.equal(root, "https://chatgpt.com/g/g-p-demo123/project");
  assert.equal(sameProjectChatUrl(root, projectChat), true);
  assert.equal(sameProjectChatUrl(root, "https://chatgpt.com/g/g-p-other/c/x"), false);
  const loaded = loadProjects(tempConfig([{ ...project, chatUrl: projectChat, autoRollover: true }]));
  assert.equal(loaded[0].autoRollover, true);
  assert.equal(loaded[0].projectRootUrl, root);
  assert.match(loaded[0].rolloverPrompt, /автоматичне продовження/i);
});

test("rejects rollover for a non-project chat", () => {
  assert.throws(() => loadProjects(tempConfig([{ ...project, autoRollover: true }])), /ChatGPT Project/);
});

test("rejects non-ChatGPT URL and too-short timer", () => {
  assert.throws(() => loadProjects(tempConfig([{ ...project, chatUrl: "https://example.com/c/abc" }])));
  assert.throws(() => loadProjects(tempConfig([{ ...project, continueAfterSeconds: 10 }])));
});

test("normalizer drops query/hash/trailing slash", () => {
  assert.equal(normalizeChatUrl("https://chatgpt.com/c/abc/?x=1#x"), "https://chatgpt.com/c/abc");
});


test("supports state-driven completion mode and watchdog configuration", () => {
  const loaded = loadProjects(tempConfig([{
    ...project,
    autoContinueMode: "on_completion",
    completionSettleSeconds: 12,
    watchdogSeconds: 1620
  }]));
  assert.equal(loaded[0].autoContinueMode, "on_completion");
  assert.equal(loaded[0].completionSettleSeconds, 12);
  assert.equal(loaded[0].watchdogSeconds, 1620);
});

test("rejects unsafe state-driven timing configuration", () => {
  assert.throws(() => loadProjects(tempConfig([{ ...project, autoContinueMode: "unknown" }])), /autoContinueMode/);
  assert.throws(() => loadProjects(tempConfig([{ ...project, completionSettleSeconds: 1 }])), /completionSettleSeconds/);
  assert.throws(() => loadProjects(tempConfig([{ ...project, watchdogSeconds: 20 }])), /watchdogSeconds/);
});
