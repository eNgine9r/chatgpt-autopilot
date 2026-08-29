import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjects, normalizeChatUrl, publicProjects } from "../src/config.mjs";

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

test("loads and normalizes valid ChatGPT project", () => {
  const loaded = loadProjects(tempConfig([project]));
  assert.equal(loaded[0].chatUrl, "https://chatgpt.com/c/abc");
  assert.equal(publicProjects(loaded).length, 1);
});

test("rejects non-ChatGPT URL and too-short timer", () => {
  assert.throws(() => loadProjects(tempConfig([{ ...project, chatUrl: "https://example.com/c/abc" }])));
  assert.throws(() => loadProjects(tempConfig([{ ...project, continueAfterSeconds: 10 }])));
});

test("normalizer drops query/hash/trailing slash", () => {
  assert.equal(normalizeChatUrl("https://chatgpt.com/c/abc/?x=1#x"), "https://chatgpt.com/c/abc");
});
