import { spawn } from 'node:child_process';

const ALLOWED = new Set(['git', 'systemctl']);

function appendBounded(state, budget, chunk, maxBytes) {
  budget.totalBytes += chunk.length;
  if (budget.storedBytes >= maxBytes) { budget.truncated = true; return; }
  const remaining = maxBytes - budget.storedBytes;
  const slice = chunk.subarray(0, remaining);
  state.chunks.push(slice);
  state.bytes += slice.length;
  budget.storedBytes += slice.length;
  if (slice.length < chunk.length) budget.truncated = true;
}

export function runReadCommand(command, args, options = {}) {
  if (!ALLOWED.has(command)) throw new Error('READ_COMMAND_NOT_ALLOWED');
  if (!Array.isArray(args) || args.length > 128 || args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) {
    throw new Error('READ_COMMAND_INVALID_ARGS');
  }
  const timeoutMs = Number(options.timeoutMs ?? 5_000);
  const maxOutputBytes = Number(options.maxOutputBytes ?? 64 * 1024);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error('READ_COMMAND_INVALID_TIMEOUT');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 64 * 1024) throw new Error('READ_COMMAND_INVALID_OUTPUT_LIMIT');

  const env = {
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
  };
  for (const key of ['HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const uid = process.getuid?.();
  if (uid !== undefined && !env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
  if (uid !== undefined && !env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${uid}/bus`;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = { chunks: [], bytes: 0 };
    const stderr = { chunks: [], bytes: 0 };
    const budget = { storedBytes: 0, totalBytes: 0, truncated: false };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => appendBounded(stdout, budget, chunk, maxOutputBytes));
    child.stderr.on('data', (chunk) => appendBounded(stderr, budget, chunk, maxOutputBytes));
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null,
        timedOut,
        stdout: Buffer.concat(stdout.chunks).toString('utf8'),
        stderr: Buffer.concat(stderr.chunks).toString('utf8'),
        truncated: budget.truncated,
        totalBytes: budget.totalBytes,
      });
    });
  });
}
