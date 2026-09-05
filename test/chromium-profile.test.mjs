import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromiumPreferencesPath, ensureChromiumDeveloperMode, withExtensionsDeveloperMode } from "../src/chromium-profile.mjs";

test("developer mode merge preserves existing Chromium preferences", () => {
  const original = { browser: { check_default_browser: false }, extensions: { pinned_by_default: true, ui: { other: "keep" } } };
  const next = withExtensionsDeveloperMode(original);
  assert.equal(next.extensions.ui.developer_mode, true);
  assert.equal(next.extensions.ui.other, "keep");
  assert.equal(next.extensions.pinned_by_default, true);
  assert.deepEqual(next.browser, original.browser);
  assert.equal(original.extensions.ui.developer_mode, undefined);
});

test("profile bootstrap creates and idempotently updates Default Preferences", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-chromium-profile-"));
  const pref = chromiumPreferencesPath(root);
  const first = ensureChromiumDeveloperMode(root);
  assert.equal(first.changed, true);
  assert.equal(JSON.parse(fs.readFileSync(pref, "utf8")).extensions.ui.developer_mode, true);
  const saved = JSON.parse(fs.readFileSync(pref, "utf8"));
  saved.profile = { name: "Shared" };
  fs.writeFileSync(pref, JSON.stringify(saved));
  const second = ensureChromiumDeveloperMode(root);
  assert.equal(second.changed, false);
  assert.equal(JSON.parse(fs.readFileSync(pref, "utf8")).profile.name, "Shared");
});

test("malformed Preferences fail closed before Chromium can launch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-chromium-profile-bad-"));
  const pref = chromiumPreferencesPath(root);
  fs.mkdirSync(path.dirname(pref), { recursive: true });
  fs.writeFileSync(pref, "{bad json");
  assert.throws(() => ensureChromiumDeveloperMode(root), SyntaxError);
});
