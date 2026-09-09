import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runReadCommand } from './read-command.mjs';

function params(value, required = [], optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('READ_PARAMS_INVALID');
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`READ_PARAMS_MISSING_${key.toUpperCase()}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`READ_PARAMS_UNKNOWN_${key.toUpperCase()}`);
}

function integer(value, fallback, min, max, code) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(code);
  return number;
}

function requireSuccess(result, code) {
  if (result.timedOut) throw new Error(`${code}_TIMEOUT`);
  if (result.exitCode !== 0) throw new Error(code);
  return result;
}

export function deviceHealthData(input = {}) {
  params(input);
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    kernel: os.release(),
    uptimeSeconds: Math.trunc(os.uptime()),
    loadAverage: os.loadavg().map((value) => Number(value.toFixed(3))),
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    cpuCount: os.cpus().length,
    nodeVersion: process.version,
    pid: process.pid,
    uid: process.getuid?.() ?? null,
  };
}

export async function processListData(input = {}) {
  params(input, [], ['limit']);
  const limit = integer(input.limit, 100, 1, 256, 'READ_INVALID_PROCESS_LIMIT');
  const ownUid = process.getuid?.();
  const names = (await fs.readdir('/proc')).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b));
  const processes = [];
  for (const name of names) {
    if (processes.length >= limit) break;
    const status = await fs.readFile(`/proc/${name}/status`, 'utf8').catch(() => null);
    if (!status) continue;
    const fields = Object.fromEntries(status.split('\n').filter(Boolean).map((line) => {
      const index = line.indexOf(':');
      return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1).trim()];
    }));
    const uid = Number((fields.Uid || '').split(/\s+/)[0]);
    if (ownUid !== undefined && uid !== ownUid) continue;
    processes.push({
      pid: Number(name),
      name: String(fields.Name || '').slice(0, 128),
      state: String(fields.State || '').slice(0, 64),
      rssKiB: Number((fields.VmRSS || '0').split(/\s+/)[0]) || 0,
      uid: Number.isInteger(uid) ? uid : null,
    });
  }
  return { processes, truncated: processes.length >= limit };
}

export async function serviceStatusData(policy, input, runner = runReadCommand) {
  params(input, ['service']);
  const service = policy.assertService(input.service);
  const result = requireSuccess(await runner('systemctl', [
    '--user', 'show', service, '--no-pager',
    '--property=Id,LoadState,ActiveState,SubState,UnitFileState,MainPID',
  ], { timeoutMs: 3_000, maxOutputBytes: 16 * 1024 }), 'READ_SERVICE_STATUS_FAILED');
  const values = {};
  for (const line of result.stdout.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1);
  }
  return {
    service,
    loadState: values.LoadState || 'unknown',
    activeState: values.ActiveState || 'unknown',
    subState: values.SubState || 'unknown',
    unitFileState: values.UnitFileState || 'unknown',
    mainPid: Number(values.MainPID || 0) || 0,
  };
}

function safeRepoPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || path.isAbsolute(value) || value.includes('\0')) {
    throw new Error('READ_GIT_INVALID_PATH');
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || normalized.startsWith('-')) {
    throw new Error('READ_GIT_INVALID_PATH');
  }
  return normalized;
}


function gitPrefix(repo) {
  return ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo];
}

export async function gitStatusData(policy, input, runner = runReadCommand) {
  params(input, ['repo']);
  const repo = await policy.assertRepository(input.repo);
  const result = requireSuccess(await runner('git', [...gitPrefix(repo), 'status', '--porcelain=v1', '--branch', '--untracked-files=normal'], {
    timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
  }), 'READ_GIT_STATUS_FAILED');
  const lines = result.stdout.split('\n').filter(Boolean);
  return { repo, branch: lines[0]?.startsWith('## ') ? lines.shift().slice(3) : '', changes: lines, truncated: result.truncated };
}

export async function gitDiffData(policy, input, runner = runReadCommand) {
  params(input, ['repo'], ['staged', 'paths', 'maxBytes']);
  const repo = await policy.assertRepository(input.repo);
  if (input.staged !== undefined && typeof input.staged !== 'boolean') throw new Error('READ_GIT_INVALID_STAGED');
  const maxBytes = integer(input.maxBytes, 32 * 1024, 1024, 64 * 1024, 'READ_GIT_INVALID_MAX_BYTES');
  const paths = input.paths ?? [];
  if (!Array.isArray(paths) || paths.length > 32) throw new Error('READ_GIT_INVALID_PATHS');
  const args = [...gitPrefix(repo), 'diff', '--no-ext-diff', '--no-textconv', '--no-color'];
  if (input.staged) args.push('--cached');
  args.push('--', ...paths.map(safeRepoPath));
  const result = requireSuccess(await runner('git', args, { timeoutMs: 5_000, maxOutputBytes: maxBytes }), 'READ_GIT_DIFF_FAILED');
  return { repo, diff: result.stdout, truncated: result.truncated, totalBytes: result.totalBytes };
}

export async function gitLogData(policy, input, runner = runReadCommand) {
  params(input, ['repo'], ['limit']);
  const repo = await policy.assertRepository(input.repo);
  const limit = integer(input.limit, 20, 1, 50, 'READ_GIT_INVALID_LOG_LIMIT');
  const result = requireSuccess(await runner('git', [
    ...gitPrefix(repo), 'log', `-n${limit}`, '--no-decorate', '--date=iso-strict', '--pretty=format:%H%x09%aI%x09%s',
  ], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }), 'READ_GIT_LOG_FAILED');
  const commits = result.stdout.split('\n').filter(Boolean).map((line) => {
    const [sha = '', authoredAt = '', ...subject] = line.split('\t');
    return { sha, authoredAt, subject: subject.join('\t').slice(0, 512) };
  });
  return { repo, commits, truncated: result.truncated };
}
