import test from 'node:test';
import assert from 'node:assert/strict';
import { runReadCommand } from '../src/commander/agent/read-command.mjs';

test('read command runner rejects generic shell and unsafe argument shapes', async () => {
  assert.throws(() => runReadCommand('bash', ['-c', 'id']), /READ_COMMAND_NOT_ALLOWED/);
  assert.throws(() => runReadCommand('git', ['ok\0bad']), /READ_COMMAND_INVALID_ARGS/);
});

test('read command runner uses one bounded stdout+stderr budget', async () => {
  const result = await runReadCommand('git', ['--version'], { maxOutputBytes: 1024, timeoutMs: 2_000 });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^git version/);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1024);
  assert.ok(result.totalBytes >= Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr));
});
