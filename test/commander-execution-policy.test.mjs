import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExecutionPolicy, phase4ExecutionCapabilities } from '../src/commander/agent/execution-policy.mjs';

const base = { version: 1, maxConcurrent: 2, commands: { probe: { executable: '/usr/bin/true', args: [], cwd: '/tmp', timeoutMs: 1000, allowStdin: false } } };

test('execution policy accepts only fixed absolute command definitions', () => {
  const policy = validateExecutionPolicy(base);
  assert.equal(policy.maxConcurrent, 2);
  assert.equal(policy.commands.get('probe').executable, '/usr/bin/true');
  assert.throws(() => validateExecutionPolicy({ ...base, commands: { probe: { ...base.commands.probe, executable: 'true' } } }), /invalid_execution_executable/);
  assert.throws(() => validateExecutionPolicy({ ...base, commands: { probe: { ...base.commands.probe, executable: '/bin/bash', args: ['-c', 'echo nope'] } } }), /execution_executable_denied/);
  assert.throws(() => validateExecutionPolicy({ ...base, commands: { probe: { ...base.commands.probe, args: ['x'.repeat(3000)] } } }), /invalid_execution_arg/);
  assert.throws(() => validateExecutionPolicy({ ...base, maxConcurrent: 99 }), /invalid_execution_concurrency/);
});

test('Phase 4 advertises only execution lifecycle operations and no ADMIN capability', () => {
  const capabilities = phase4ExecutionCapabilities();
  assert.deepEqual(capabilities.map((c) => c.operation), ['execution.start', 'execution.get', 'execution.output', 'execution.input', 'execution.cancel']);
  assert.equal(capabilities.some((c) => c.authority === 'admin'), false);
});


test('interactive operator shell is explicit, fixed, stdin-enabled and no-new-privs', () => {
  const policy = validateExecutionPolicy({
    ...base,
    interactiveShell: { enabled: true, cwd: '/tmp', timeoutMs: 1800000 },
  });
  const shell = policy.commands.get('operator.shell');
  assert.equal(policy.interactiveShellEnabled, true);
  assert.equal(shell.executable, '/usr/bin/setpriv');
  assert.deepEqual(shell.args, ['--no-new-privs', '/bin/bash', '--noprofile', '--norc']);
  assert.equal(shell.allowStdin, true);
  assert.equal(shell.timeoutMs, 1800000);
  assert.throws(() => validateExecutionPolicy({
    ...base, interactiveShell: { enabled: true, cwd: 'relative', timeoutMs: 1000 },
  }), /invalid_interactive_shell_cwd/);
  assert.throws(() => validateExecutionPolicy({
    ...base, commands: { ...base.commands, 'operator.shell': base.commands.probe },
    interactiveShell: { enabled: true, cwd: '/tmp', timeoutMs: 1000 },
  }), /interactive_shell_alias_conflict/);
});

test('interactive shell remains absent when the explicit gate is disabled', () => {
  const policy = validateExecutionPolicy({ ...base, interactiveShell: { enabled: false } });
  assert.equal(policy.interactiveShellEnabled, false);
  assert.equal(policy.commands.has('operator.shell'), false);
});
