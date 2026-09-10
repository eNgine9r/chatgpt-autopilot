import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ALLOWED_TEST_COMMANDS } from './config.mjs';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 12000;

function bounded(value, limit = MAX_OUTPUT) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

function cleanEnv() {
  const names = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'];
  const env = { CI: '1' };
  for (const name of names) if (process.env[name]) env[name] = process.env[name];
  return env;
}

async function runFile(command, args, options = {}) {
  const timeout = Number(options.timeoutMs ?? 300000);
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: cleanEnv(),
      timeout,
      maxBuffer: MAX_OUTPUT * 4,
      windowsHide: true,
    });    return { stdout: bounded(result.stdout), stderr: bounded(result.stderr), exitCode: 0 };
  } catch (error) {
    const detail = bounded(error.stderr || error.stdout || error.message, 4000);
    const wrapped = new Error(error.killed ? `command_timeout:${detail}` : `command_failed:${detail}`);
    wrapped.code = error.code;
    throw wrapped;
  }
}

function isRemote(project) {
  return project.transport?.type === 'ssh-gateway';
}

function sshArgs(project, operation) {
  const t = project.transport;
  const args = [
    '-F', '/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=5',
    '-i', t.identityFile,
  ];
  if (Number(t.port ?? 22) !== 22) args.push('-p', String(t.port));
  args.push(`${t.user}@${t.host}`, operation);
  return args;
}

async function runRemote(project, operation, runner, timeoutMs) {
  const result = await runner('ssh', sshArgs(project, operation), { timeoutMs });
  const text = result.stdout.trim();
  if (!text) throw new Error('remote_gateway_empty_response');
  try { JSON.parse(text); } catch { throw new Error('remote_gateway_invalid_json'); }
  return text;
}
async function inspectRepo(project, runner) {
  if (isRemote(project)) return runRemote(project, 'inspect', runner, 30000);
  const cwd = project.repoPath;
  const head = (await runner('git', ['rev-parse', '--verify', 'HEAD'], { cwd, timeoutMs: 15000 })).stdout.trim();
  const branch = (await runner('git', ['branch', '--show-current'], { cwd, timeoutMs: 15000 })).stdout.trim();
  const status = (await runner('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd, timeoutMs: 15000 })).stdout;
  return JSON.stringify({ head, branch, cleanTracked: status.trim() === '', trackedStatus: bounded(status, 4000) });
}

async function runTest(project, dispatch, runner) {
  const alias = String(dispatch.params?.alias ?? '');
  const spec = project.tests?.[alias];
  if (!spec) throw new Error(`unknown_test_alias:${alias}`);
  if (isRemote(project)) {
    return runRemote(project, `test ${alias}`, runner, spec.timeoutMs ?? 600000);
  }
  if (!ALLOWED_TEST_COMMANDS.has(spec.command)) throw new Error(`test_command_not_allowed:${spec.command}`);
  const result = await runner(spec.command, spec.args ?? [], {
    cwd: project.repoPath,
    timeoutMs: spec.timeoutMs ?? 600000,
  });
  return JSON.stringify({ alias, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
}

export class DeterministicExecutor {
  constructor(options = {}) {
    this.runner = options.runner ?? runFile;
    this.commanderEnabled = options.commanderEnabled === true;
    this.commanderClient = options.commanderClient ?? null;
  }

  async execute(project, dispatch) {
    if (this.commanderEnabled && project.commander?.enabled === true && dispatch.action.startsWith('repo.')) {
      if (!this.commanderClient || typeof this.commanderClient.execute !== 'function') throw new Error('commander_client_unavailable');
      return this.commanderClient.execute(project, dispatch);
    }
    switch (dispatch.action) {      case 'repo.inspect': return inspectRepo(project, this.runner);
      case 'repo.test': return runTest(project, dispatch, this.runner);
      case 'operator.review': return JSON.stringify({ approved: true });
      default: throw new Error(`unsupported_action:${dispatch.action}`);
    }
  }
}

export { runFile, sshArgs };
