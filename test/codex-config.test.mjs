import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjects, publicProjects } from "../src/config.mjs";
import { buildCodexTransport } from "../src/codex-rpc.mjs";

function tempConfig(project) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-codex-config-"));
  const file = path.join(dir, "projects.json");
  fs.writeFileSync(file, JSON.stringify({ projects: [project] }));
  return file;
}

const codexProject = {
  id: "worker",
  name: "Worker Project",
  backend: "codex",
  repoPath: "/srv/project",
  continuationPrompt: "Continue safely",
  continueAfterSeconds: 1800,
  codex: {
    transport: {
      type: "ssh",
      host: "worker-host",
      user: "worker",
      identityFile: "/home/autopilot/.ssh/worker-key"
    }
  }
};

test("loads Codex project without exposing it to the browser extension", () => {
  const [loaded] = loadProjects(tempConfig(codexProject));
  assert.equal(loaded.backend, "codex");
  assert.equal(loaded.chatUrl, "");
  assert.equal(loaded.codex.approvalPolicy, "on-request");
  assert.equal(loaded.codex.networkAccess, false);
  assert.equal(publicProjects([loaded]).length, 0);
});

test("builds restricted SSH transport command", () => {
  const [loaded] = loadProjects(tempConfig(codexProject));
  const transport = buildCodexTransport(loaded);
  assert.equal(transport.command, "/usr/bin/ssh");
  assert.ok(transport.args.includes("BatchMode=yes"));
  assert.ok(transport.args.includes("IdentitiesOnly=yes"));
  assert.ok(transport.args.includes("StrictHostKeyChecking=yes"));
  assert.ok(transport.args.includes("/home/autopilot/.ssh/worker-key"));
  assert.equal(transport.args.at(-1), "worker@worker-host");
});

test("rejects incomplete Codex SSH configuration", () => {
  const invalid = structuredClone(codexProject);
  delete invalid.codex.transport.identityFile;
  assert.throws(() => loadProjects(tempConfig(invalid)), /identityFile/);
});
