import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runWriteCommand } from '../src/commander/agent/write-command.mjs';

const exec = promisify(execFile);
const askpass = fileURLToPath(new URL('../src/commander/agent/github-askpass.py', import.meta.url));

test('write command runner rejects shell, Git aliases/exec overrides and non-user systemctl', () => {
  assert.throws(() => runWriteCommand('bash', ['-c', 'true']), /WRITE_COMMAND_NOT_ALLOWED/);
  assert.throws(() => runWriteCommand('git', ['-c', 'alias.evil=!sh -c true', 'evil']), /WRITE_COMMAND_UNSAFE_GIT_CONFIG/);
  assert.throws(() => runWriteCommand('git', ['-c', 'user.name=Bad\nName', 'rev-parse', 'HEAD']), /WRITE_COMMAND_UNSAFE_GIT_CONFIG/);
  assert.doesNotThrow(() => runWriteCommand('git', ['-c', 'user.name=Commander', '-c', 'user.email=commander@localhost.invalid', 'rev-parse', 'HEAD']));
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


test('GitHub askpass exposes only bounded prompt behavior without leaking credentials', async () => {
  const username = await exec('/usr/bin/python3', [askpass, "Username for 'https://github.com':"]);
  assert.equal(username.stdout.trim(), 'x-access-token');
  await assert.rejects(() => exec('/usr/bin/python3', [askpass, "Username for 'https://example.com':"]));
});
