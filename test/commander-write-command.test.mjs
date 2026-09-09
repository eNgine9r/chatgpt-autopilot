import test from 'node:test';
import assert from 'node:assert/strict';
import { runWriteCommand } from '../src/commander/agent/write-command.mjs';

test('write command runner rejects shell, Git aliases/exec overrides and non-user systemctl', () => {
  assert.throws(() => runWriteCommand('bash', ['-c', 'true']), /WRITE_COMMAND_NOT_ALLOWED/);
  assert.throws(() => runWriteCommand('git', ['-c', 'alias.evil=!sh -c true', 'evil']), /WRITE_COMMAND_UNSAFE_GIT_CONFIG/);
  assert.throws(() => runWriteCommand('git', ['status']), /WRITE_COMMAND_GIT_SUBCOMMAND_NOT_ALLOWED/);
  assert.throws(() => runWriteCommand('git', ['push', '--receive-pack=/bin/sh', 'origin', 'HEAD']), /WRITE_COMMAND_GIT_EXEC_OVERRIDE_DENIED/);
  assert.throws(() => runWriteCommand('systemctl', ['restart', 'demo.service']), /WRITE_COMMAND_SYSTEMCTL_SHAPE_DENIED/);
});

test('write command runner accepts only bounded known read/write command shapes', async () => {
  const git = await runWriteCommand('git', ['rev-parse', '--version'], { timeoutMs: 3000 });
  // rev-parse accepts --version and remains a non-shell Git invocation; the dispatcher uses stricter fixed forms.
  assert.equal(typeof git.exitCode, 'number');
  assert.throws(() => runWriteCommand('systemctl', ['--user', 'show', '../bad.service', '--property=LoadState,ActiveState,SubState,UnitFileState,MainPID', '--no-pager']), /WRITE_COMMAND_SYSTEMCTL_SHAPE_DENIED/);
});
