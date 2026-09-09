import { spawn } from 'node:child_process';

const ALLOWED = new Set(['git', 'systemctl']);
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,126}\.service$/;
const SAFE_GIT_CONFIG = new Set([
  'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'diff.external=', 'credential.helper=',
  'commit.gpgSign=false', 'protocol.ext.allow=never',
  'core.sshCommand=/usr/bin/ssh -F /dev/null -o BatchMode=yes -o ClearAllForwardings=yes',
]);
const GIT_SUBCOMMANDS = new Set([
  'symbolic-ref', 'rev-parse', 'diff', 'hash-object', 'update-index', 'write-tree',
  'commit-tree', 'update-ref', 'read-tree', 'remote', 'ls-remote', 'push',
]);

function validateCommonArgs(args) {
  if (!Array.isArray(args) || args.length > 128 || args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) {
    throw new Error('WRITE_COMMAND_INVALID_ARGS');
  }
}
function validateGitArgs(args) {
  let index = 0;
  while (args[index] === '-c') {
    const setting = args[index + 1];
    if (!SAFE_GIT_CONFIG.has(setting)) throw new Error('WRITE_COMMAND_UNSAFE_GIT_CONFIG');
    index += 2;
  }
  const subcommand = args[index];
  if (!GIT_SUBCOMMANDS.has(subcommand)) throw new Error('WRITE_COMMAND_GIT_SUBCOMMAND_NOT_ALLOWED');
  const rest = args.slice(index + 1);
  if (rest.some((arg) => arg === '--exec-path' || arg.startsWith('--exec-path=') || arg.startsWith('--upload-pack=') || arg.startsWith('--receive-pack='))) {
    throw new Error('WRITE_COMMAND_GIT_EXEC_OVERRIDE_DENIED');
  }
}
function validateSystemctlArgs(args) {
  if (args[0] !== '--user' || !['show', 'start', 'stop', 'restart'].includes(args[1]) || !SERVICE.test(args[2] || '')) {
    throw new Error('WRITE_COMMAND_SYSTEMCTL_SHAPE_DENIED');
  }
  if (args[1] === 'show') {
    if (args.length !== 5 || args[3] !== '--property=LoadState,ActiveState,SubState,UnitFileState,MainPID' || args[4] !== '--no-pager') {
      throw new Error('WRITE_COMMAND_SYSTEMCTL_SHAPE_DENIED');
    }
  } else if (args.length !== 3) throw new Error('WRITE_COMMAND_SYSTEMCTL_SHAPE_DENIED');
}

export function runWriteCommand(command, args, options = {}) {
  if (!ALLOWED.has(command)) throw new Error('WRITE_COMMAND_NOT_ALLOWED');
  validateCommonArgs(args);
  if (command === 'git') validateGitArgs(args); else validateSystemctlArgs(args);
  const timeoutMs = Number(options.timeoutMs ?? 30_000);
  const maxOutputBytes = Number(options.maxOutputBytes ?? 64 * 1024);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('WRITE_COMMAND_INVALID_TIMEOUT');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 64 * 1024) throw new Error('WRITE_COMMAND_INVALID_OUTPUT_LIMIT');
  const env = {
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_SSH_COMMAND: '/usr/bin/ssh -F /dev/null -o BatchMode=yes -o ClearAllForwardings=yes',
  };
  for (const key of ['HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK']) if (process.env[key]) env[key] = process.env[key];
  const uid = process.getuid?.();
  if (uid !== undefined && !env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
  if (uid !== undefined && !env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${uid}/bus`;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let stored = 0; let total = 0; let truncated = false;
    const add = (stream, chunk) => { total += chunk.length; if (stored >= maxOutputBytes) { truncated = true; return; } const keep = chunk.subarray(0, maxOutputBytes - stored); chunks.push([stream, keep]); stored += keep.length; if (keep.length < chunk.length) truncated = true; };
    const terminate = (signal) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; terminate('SIGTERM'); setTimeout(() => terminate('SIGKILL'), 250).unref?.(); }, timeoutMs); timer.unref?.();
    child.stdout.on('data', (c) => add('stdout', c)); child.stderr.on('data', (c) => add('stderr', c));
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ exitCode: Number.isInteger(code) ? code : null, signal: signal || null, timedOut, stdout: Buffer.concat(chunks.filter(([s]) => s === 'stdout').map(([, b]) => b)).toString('utf8'), stderr: Buffer.concat(chunks.filter(([s]) => s === 'stderr').map(([, b]) => b)).toString('utf8'), truncated, totalBytes: total }); });
  });
}
