import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { persistProjectChatUrl } from "../src/project-store.mjs";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-rollover-"));
  const file = path.join(dir, "projects.json");
  fs.writeFileSync(file, JSON.stringify({ projects: [
    { id: "btc", chatUrl: "https://chatgpt.com/g/g-p-demo/c/old", keep: "yes" }
  ] }, null, 2), { mode: 0o600 });
  return file;
}

test("rollover persists only a same-project chat URL atomically", () => {
  const file = fixture();
  const next = persistProjectChatUrl(
    file,
    "btc",
    "https://chatgpt.com/g/g-p-demo/project",
    "https://chatgpt.com/g/g-p-demo/c/new?x=1"
  );
  assert.equal(next, "https://chatgpt.com/g/g-p-demo/c/new");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.projects[0].chatUrl, next);
  assert.equal(saved.projects[0].keep, "yes");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("rollover refuses a chat from another project", () => {
  const file = fixture();
  assert.throws(() => persistProjectChatUrl(
    file,
    "btc",
    "https://chatgpt.com/g/g-p-demo/project",
    "https://chatgpt.com/g/g-p-other/c/new"
  ), /outside_project/);
});

test("rollover persists a slugged chat URL for the same canonical Project", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-rollover-slug-"));
  const file = path.join(dir, "projects.json");
  const id = "g-p-0123456789abcdef0123456789abcdef";
  fs.writeFileSync(file, JSON.stringify({ projects: [
    { id: "btc", chatUrl: `https://chatgpt.com/g/${id}/c/old` }
  ] }, null, 2), { mode: 0o600 });
  const next = persistProjectChatUrl(
    file,
    "btc",
    `https://chatgpt.com/g/${id}/project`,
    `https://chatgpt.com/g/${id}-bot-tg-bc/c/new?messageId=x`
  );
  assert.equal(next, `https://chatgpt.com/g/${id}-bot-tg-bc/c/new`);
});
