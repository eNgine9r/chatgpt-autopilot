#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const COMMANDER_UNITS = [
  'chatgpt-autopilot-commander-gateway.service',
  'chatgpt-autopilot-commander-agent.service',
];
const REQUIRED_DISABLED = [
  'COMMANDER_ENABLED', 'COMMANDER_EXECUTION_ENABLED',
  'COMMANDER_WRITE_ENABLED', 'COMMANDER_ADMIN_ENABLED',
];

function run(command, args, options = {}) {
  try {
    return { ok: true, stdout: execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim() };
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout || '').trim(), stderr: String(error?.stderr || '').trim(), status: error?.status };
  }
}

function parseArgs(argv) {
  const out = { repo: process.cwd(), port: 8790, fallbackProcess: 'desktop-commander remote' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid_preflight_arguments');
    if (key === '--repo') out.repo = path.resolve(value);
    else if (key === '--expected-head') out.expectedHead = value;
    else if (key === '--tailscale-ip') out.tailscaleIp = value;
    else if (key === '--port') out.port = Number(value);
    else if (key === '--fallback-process') out.fallbackProcess = value;
    else throw new Error(`unknown_preflight_argument:${key}`);
  }
  if (!/^[0-9a-f]{40}$/.test(out.expectedHead || '')) throw new Error('expected_head_required');
  if (!out.tailscaleIp) throw new Error('tailscale_ip_required');
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('invalid_preflight_port');
  return out;
}

function envMap(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const index = value.indexOf('=');
    if (index > 0) result[value.slice(0, index)] = value.slice(index + 1);
  }
  return result;
}

async function privateFileState(file, requiredKeys) {
  try {
    const stat = await fs.stat(file);
    const data = envMap(await fs.readFile(file, 'utf8'));
    return {
      exists: stat.isFile(), private: (stat.mode & 0o077) === 0,
      disabled: requiredKeys.every((key) => data[key] === 'false'),
    };
  } catch { return { exists: false, private: false, disabled: false }; }
}

async function privateDirState(dir) {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory() && (stat.mode & 0o077) === 0;
  } catch { return false; }
}

export function evaluateCommanderStagePreflight(input) {
  const checks = {
    node22: Number(input.nodeMajor) >= 22,
    exactHead: input.head === input.expectedHead,
    cleanSource: input.dirty === false,
    tailscaleIpAssigned: input.tailscaleAddresses.includes(input.expectedTailscaleIp),
    commanderUnitsDisabled: COMMANDER_UNITS.every((unit) => input.units[unit]?.enabled === 'disabled'),
    commanderUnitsInactive: COMMANDER_UNITS.every((unit) => input.units[unit]?.active === 'inactive'),
    commanderPortClosed: input.listenerKnown === true && input.listenerCount === 0,
    fallbackAvailable: input.processListKnown === true && input.fallbackProcessCount > 0,
    configPrivate: input.configPrivate === true,
    configDisabled: input.configDisabled === true,
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}

export async function collectCommanderStagePreflight(options) {
  const uid = process.getuid?.();
  const runtimeDir = process.env.XDG_RUNTIME_DIR || (Number.isInteger(uid) ? `/run/user/${uid}` : '');
  const userBusEnv = runtimeDir ? { ...process.env, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus` } : process.env;
  const head = run('git', ['-C', options.repo, 'rev-parse', 'HEAD']);
  const status = run('git', ['-C', options.repo, 'status', '--porcelain']);
  const interfaces = os.networkInterfaces();
  const tailscaleAddresses = (interfaces.tailscale0 || []).map((entry) => entry.address).filter(Boolean);
  const units = {};
  for (const unit of COMMANDER_UNITS) {
    const enabled = run('systemctl', ['--user', 'is-enabled', unit], { env: userBusEnv });
    const active = run('systemctl', ['--user', 'is-active', unit], { env: userBusEnv });
    units[unit] = { enabled: enabled.stdout || 'unknown', active: active.stdout || 'unknown' };
  }
  const listener = run('ss', ['-H', '-ltn', `sport = :${options.port}`]);
  const processes = run('ps', ['-eo', 'args=']);
  const home = os.homedir();
  const configDir = path.join(home, '.config/chatgpt-autopilot-commander');
  const stateDir = path.join(home, '.local/state/chatgpt-autopilot-commander');
  const agent = await privateFileState(path.join(configDir, 'agent.env'), REQUIRED_DISABLED);
  const gateway = await privateFileState(path.join(configDir, 'gateway.env'), [...REQUIRED_DISABLED, 'COMMANDER_PRIVATE_BIND_ENABLED']);
  const configPrivate = await privateDirState(configDir) && await privateDirState(stateDir) && agent.exists && agent.private && gateway.exists && gateway.private;
  const evaluation = evaluateCommanderStagePreflight({
    nodeMajor: Number(process.versions.node.split('.')[0]), head: head.stdout, expectedHead: options.expectedHead,
    dirty: status.ok ? status.stdout.length > 0 : null, tailscaleAddresses, expectedTailscaleIp: options.tailscaleIp,
    units, listenerKnown: listener.ok, listenerCount: listener.stdout ? listener.stdout.split(/\r?\n/).length : 0,
    processListKnown: processes.ok, fallbackProcessCount: processes.stdout.split(/\r?\n/).filter((line) => line.includes(options.fallbackProcess)).length,
    configPrivate, configDisabled: agent.disabled && gateway.disabled,
  });
  return {
    phase: 8, stage: 1, host: os.hostname(), sourceHead: head.stdout,
    expectedHead: options.expectedHead, tailscaleIp: options.tailscaleIp,
    ...evaluation,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await collectCommanderStagePreflight(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ phase: 8, stage: 1, ok: false, error: String(error?.message || error) }));
    process.exitCode = 1;
  });
}
