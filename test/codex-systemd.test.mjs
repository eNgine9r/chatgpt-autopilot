import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const unit = fs.readFileSync(new URL("../systemd/chatgpt-codex-autopilot.service.template", import.meta.url), "utf8");

test("Codex supervisor restarts after clean transport-driven exit", () => {
  assert.match(unit, /^Restart=always$/m);
  assert.doesNotMatch(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^RestartSec=10$/m);
});
