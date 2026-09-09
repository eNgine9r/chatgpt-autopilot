import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function sshArgs(publisher, operation) {
  const args = [
    "-T",
    "-F", "/dev/null",
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    "-i", publisher.identityFile,
  ];
  if (Number(publisher.port ?? 22) !== 22) args.push("-p", String(publisher.port));
  args.push(`${publisher.user}@${publisher.host}`, operation);
  return args;
}

async function runPublisher(project, operation, runner = execFileAsync) {
  const publisher = project.codex?.publisher;
  if (!publisher?.enabled) throw new Error("codex_publisher_disabled");
  const result = await runner(publisher.sshExecutable || "/usr/bin/ssh", sshArgs(publisher, operation), {
    timeout: 60000,
    maxBuffer: 256 * 1024,
    env: process.env,
  });
  const text = String(result.stdout || "").trim();
  if (!text) throw new Error("codex_publisher_empty_response");
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("codex_publisher_invalid_json"); }
  return parsed;
}

export class CodexPublisher {
  constructor(project, options = {}) {
    this.project = project;
    this.runner = options.runner ?? execFileAsync;
  }

  async inspect() {
    return runPublisher(this.project, "inspect", this.runner);
  }

  async publish(expectedHead, expectedBranch) {
    if (!/^[0-9a-f]{40}$/i.test(String(expectedHead || ""))) {
      throw new Error("codex_publisher_invalid_expected_head");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(String(expectedBranch || ""))) {
      throw new Error("codex_publisher_invalid_expected_branch");
    }
    if (["main", "master"].includes(String(expectedBranch))) {
      throw new Error("codex_publisher_protected_branch");
    }
    return runPublisher(this.project, `publish ${expectedHead} ${expectedBranch}`, this.runner);
  }
}

export { sshArgs };
