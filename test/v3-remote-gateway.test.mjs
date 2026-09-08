import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const script = new URL('../scripts/v3-remote-gateway.py', import.meta.url);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-gateway-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const config = path.join(root, 'remote.json');
  await fs.mkdir(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Gateway Test'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'demo.py'), 'x = 1\n');
  execFileSync('git', ['add', 'demo.py'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  await fs.writeFile(config, JSON.stringify({
    version: 3,
    repoPath: repo,
    tests: {
      syntax: { command: 'python3', args: ['-c', 'import ast,pathlib; ast.parse(pathlib.Path("demo.py").read_text())'], timeoutMs: 1000 },
    },
  }));
  return { root, repo, config };
}

async function gateway(command, config) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    AUTOPILOT_V3_REMOTE_CONFIG: config,
    SSH_ORIGINAL_COMMAND: command,
  };
  return execFileAsync('python3', [script.pathname], { env, timeout: 3000 });
}

test('remote gateway inspect and configured test return bounded JSON', async (t) => {
  const { config } = await fixture(t);
  const inspect = JSON.parse((await gateway('inspect', config)).stdout);
  assert.match(inspect.head, /^[0-9a-f]{40}$/);
  assert.equal(inspect.cleanTracked, true);

  const syntax = JSON.parse((await gateway('test syntax', config)).stdout);
  assert.equal(syntax.alias, 'syntax');
  assert.equal(syntax.exitCode, 0);
});

test('remote gateway rejects arbitrary SSH_ORIGINAL_COMMAND and alias injection', async (t) => {
  const { config } = await fixture(t);
  await assert.rejects(() => gateway('sh -c "id"', config), (error) => {
    assert.equal(error.code, 64);
    assert.match(error.stderr, /unsupported_operation/);
    return true;
  });
  await assert.rejects(() => gateway('test syntax;rm', config), (error) => {
    assert.equal(error.code, 64);
    assert.match(error.stderr, /invalid_test_alias/);
    return true;
  });
});
