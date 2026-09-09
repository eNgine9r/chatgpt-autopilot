import test from "node:test";
import assert from "node:assert/strict";
import { CodexPublisher, sshArgs } from "../src/codex-publisher.mjs";

const project = {
  codex: {
    publisher: {
      enabled: true,
      host: "nexolab-edge-01",
      user: "nexolab",
      identityFile: "/home/btcradar/.ssh/autopilot-v3-nexolab",
      sshExecutable: "/usr/bin/ssh",
      port: 22
    }
  }
};

test("Codex publisher uses restricted SSH argv", async () => {
  const calls = [];
  const publisher = new CodexPublisher(project, {
    runner: async (command, args) => {
      calls.push({ command, args });
      return { stdout: '{"head":"0123456789012345678901234567890123456789","cleanTracked":true}' };
    }
  });
  const result = await publisher.inspect();
  assert.equal(result.cleanTracked, true);
  assert.equal(calls[0].command, "/usr/bin/ssh");
  assert.equal(calls[0].args.at(-2), "nexolab@nexolab-edge-01");
  assert.equal(calls[0].args.at(-1), "inspect");
  assert.ok(calls[0].args.includes("BatchMode=yes"));
});

test("Codex publisher sends only validated expected head to gateway", async () => {
  const calls = [];
  const publisher = new CodexPublisher(project, {
    runner: async (_command, args) => {
      calls.push(args.at(-1));
      return { stdout: '{"ok":true,"branch":"fix/42","commit":"abcdef"}' };
    }
  });
  const head = "a".repeat(40);
  const result = await publisher.publish(head);
  assert.equal(calls[0], `publish ${head}`);
  assert.equal(result.ok, true);
  await assert.rejects(() => publisher.publish("main"), /invalid_expected_head/);
});

test("sshArgs rejects no shell interpolation by keeping operation one argv", () => {
  const args = sshArgs(project.codex.publisher, "publish " + "b".repeat(40));
  assert.equal(args.at(-2), "nexolab@nexolab-edge-01");
  assert.equal(args.at(-1), "publish " + "b".repeat(40));
});
