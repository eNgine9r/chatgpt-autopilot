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
  projectIdFromChatUrl,
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
  assert.equal(loaded[0].watchdogEnabled, true);
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

test("accepts slugged ChatGPT Project conversation URLs", () => {
  const id = "g-p-0123456789abcdef0123456789abcdef";
  const slugged = `https://chatgpt.com/g/${id}-bot-tg-bc/c/chat-new`;
  const root = `https://chatgpt.com/g/${id}/project`;
  assert.equal(projectIdFromChatUrl(slugged), id);
  assert.equal(deriveProjectRootUrl(slugged), root);
  assert.equal(sameProjectChatUrl(root, slugged), true);
  assert.equal(sameProjectChatUrl(root, `https://chatgpt.com/g/${id}-other-slug/c/abc`), true);
  assert.equal(sameProjectChatUrl(root, "https://chatgpt.com/g/g-p-11111111111111111111111111111111-other/c/abc"), false);
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
    startupGraceSeconds: 45,
    watchdogSeconds: 1620,
    watchdogEnabled: false,
    noProgressAlertSeconds: 1800
  }]));
  assert.equal(loaded[0].autoContinueMode, "on_completion");
  assert.equal(loaded[0].completionSettleSeconds, 12);
  assert.equal(loaded[0].startupGraceSeconds, 45);
  assert.equal(loaded[0].watchdogSeconds, 1620);
  assert.equal(loaded[0].watchdogEnabled, false);
  assert.equal(loaded[0].noProgressAlertSeconds, 1800);
});

test("rejects unsafe state-driven timing configuration", () => {
  assert.throws(() => loadProjects(tempConfig([{ ...project, autoContinueMode: "unknown" }])), /autoContinueMode/);
  assert.throws(() => loadProjects(tempConfig([{ ...project, completionSettleSeconds: 1 }])), /completionSettleSeconds/);
  assert.throws(() => loadProjects(tempConfig([{ ...project, startupGraceSeconds: 4 }])), /startupGraceSeconds/);
  assert.throws(() => loadProjects(tempConfig([{ ...project, startupGraceSeconds: 121 }])), /startupGraceSeconds/);
  assert.throws(() => loadProjects(tempConfig([{ ...project, watchdogSeconds: 20 }])), /watchdogSeconds/);
  assert.throws(() => loadProjects(tempConfig([{ ...project, noProgressAlertSeconds: 30 }])), /noProgressAlertSeconds/);
  assert.throws(() => loadProjects(tempConfig([{ ...project, noProgressAlertSeconds: 90000 }])), /noProgressAlertSeconds/);
});

test("validates startup priority", () => {
  const loaded = loadProjects(tempConfig([{ ...project, startupPriority: 10 }]));
  assert.equal(loaded[0].startupPriority, 10);
  assert.throws(() => loadProjects(tempConfig([{ ...project, startupPriority: -1 }])), /startupPriority/);
  assert.throws(() => loadProjects(tempConfig([{ ...project, startupPriority: 10.5 }])), /startupPriority/);
});
