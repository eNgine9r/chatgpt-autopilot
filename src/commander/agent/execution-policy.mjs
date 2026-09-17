import fs from 'node:fs/promises';
import path from 'node:path';
import { operationDefinition } from '../contracts/index.mjs';

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_COMMANDS = 64;
const DENIED_EXECUTABLES = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'sudo', 'su', 'doas']);

function plain(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value;
}

function exact(value, required, optional = [], code = 'invalid_execution_policy') {
  plain(value, code);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${code}:missing:${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${code}:unknown:${key}`);
}

function positiveInt(value, min, max, code) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(code);
  return value;
}

function validateCommand(alias, value) {
  if (!ALIAS.test(alias)) throw new Error('invalid_execution_alias');
  exact(value, ['executable', 'args', 'cwd', 'timeoutMs', 'allowStdin'], [], 'invalid_execution_command');
  if (!path.isAbsolute(value.executable) || value.executable.length > 1024) throw new Error('invalid_execution_executable');
  if (DENIED_EXECUTABLES.has(path.basename(value.executable))) throw new Error('execution_executable_denied');
  if (!Array.isArray(value.args) || value.args.length > 64) throw new Error('invalid_execution_args');
  for (const arg of value.args) if (typeof arg !== 'string' || arg.length > 2048 || arg.includes('\0')) throw new Error('invalid_execution_arg');
  if (!path.isAbsolute(value.cwd) || value.cwd.length > 2048) throw new Error('invalid_execution_cwd');
  positiveInt(value.timeoutMs, 100, 30 * 60 * 1000, 'invalid_execution_timeout');
  if (typeof value.allowStdin !== 'boolean') throw new Error('invalid_execution_stdin_policy');
  return Object.freeze({ alias, executable: value.executable, args: [...value.args], cwd: value.cwd, timeoutMs: value.timeoutMs, allowStdin: value.allowStdin });
}


function validateInteractiveShell(value) {
  if (value == null) return null;
  plain(value, 'invalid_interactive_shell');
  if (typeof value.enabled !== 'boolean') throw new Error('invalid_interactive_shell_enabled');
  if (!value.enabled) {
    exact(value, ['enabled'], [], 'invalid_interactive_shell');
    return null;
  }
  exact(value, ['enabled', 'cwd', 'timeoutMs'], [], 'invalid_interactive_shell');
  if (!path.isAbsolute(value.cwd) || value.cwd.length > 2048) throw new Error('invalid_interactive_shell_cwd');
  positiveInt(value.timeoutMs, 100, 30 * 60 * 1000, 'invalid_interactive_shell_timeout');
  return Object.freeze({
    alias: 'operator.shell',
    executable: '/usr/bin/setpriv',
    args: ['--no-new-privs', '/bin/bash', '--noprofile', '--norc'],
    cwd: value.cwd,
    timeoutMs: value.timeoutMs,
    allowStdin: true,
  });
}

export function validateExecutionPolicy(value) {
  exact(value, ['version', 'maxConcurrent', 'commands'], ['interactiveShell']);
  if (value.version !== 1) throw new Error('unsupported_execution_policy_version');
  positiveInt(value.maxConcurrent, 1, 8, 'invalid_execution_concurrency');
  plain(value.commands, 'invalid_execution_commands');
  const entries = Object.entries(value.commands);
  const interactiveShell = validateInteractiveShell(value.interactiveShell);
  if (entries.length + (interactiveShell ? 1 : 0) > MAX_COMMANDS) throw new Error('too_many_execution_commands');
  const commands = new Map(entries.map(([alias, command]) => [alias, validateCommand(alias, command)]));
  if (interactiveShell) {
    if (commands.has(interactiveShell.alias)) throw new Error('interactive_shell_alias_conflict');
    commands.set(interactiveShell.alias, interactiveShell);
  }
  return Object.freeze({ version: 1, maxConcurrent: value.maxConcurrent, commands, interactiveShellEnabled: Boolean(interactiveShell) });
}

export async function loadCommanderExecutionPolicy(filePath) {
  if (!path.isAbsolute(String(filePath || ''))) throw new Error('execution_policy_path_must_be_absolute');
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  return validateExecutionPolicy(raw);
}

export function phase4ExecutionCapabilities() {
  return ['execution.start', 'execution.get', 'execution.output', 'execution.input', 'execution.cancel']
    .map((operation) => Object.freeze({ operation, authority: operationDefinition(operation).authority, operationVersion: 1 }));
}
