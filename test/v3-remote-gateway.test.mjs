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
  execFileSync('git', ['switch', '-c', 'fix/42-test'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Gateway Test'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'demo.py'), 'x = 1\n');
  await fs.mkdir(path.join(repo, '.project'));
  await fs.writeFile(path.join(repo, '.project', 'ACTIVE_SPRINT.json'), JSON.stringify({
    selection: { active_work_package: { issue: 42, branch: 'fix/42-test' } },
  }));
  execFileSync('git', ['add', 'demo.py', '.project/ACTIVE_SPRINT.json'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  const remote = path.join(root, 'origin.git');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
  execFileSync('git', ['push', '-u', 'origin', 'fix/42-test'], { cwd: repo, stdio: 'ignore' });
  await fs.writeFile(config, JSON.stringify({
    version: 3,
    repoPath: repo,
    publishEnabled: true,
    tests: {
      syntax: { command: 'python3', args: ['-c', 'import ast,pathlib; ast.parse(pathlib.Path("demo.py").read_text())'], timeoutMs: 1000 },
    },
  }));
  return { root, repo, config, remote };
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

test('remote gateway publishes only tracked active-branch changes', async (t) => {
  const { repo, config, remote } = await fixture(t);
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  await fs.writeFile(path.join(repo, 'demo.py'), 'x = 2\n');
  await fs.writeFile(path.join(repo, 'scratch.pyc'), 'generated\n');

  const result = JSON.parse((await gateway(`publish ${before}`, config)).stdout);
  assert.equal(result.ok, true);
  assert.equal(result.branch, 'fix/42-test');
  assert.equal(result.issue, 42);
  assert.deepEqual(result.files, ['demo.py']);
  assert.match(result.commit, /^[0-9a-f]{40}$/);
  assert.notEqual(result.commit, before);
  assert.equal(execFileSync('git', ['show', '--format=', '--name-only', result.commit], { cwd: repo, encoding: 'utf8' }).trim(), 'demo.py');
  assert.equal(execFileSync('git', ['rev-parse', 'refs/heads/fix/42-test'], { cwd: remote, encoding: 'utf8' }).trim(), result.commit);
  assert.equal((await fs.readFile(path.join(repo, 'scratch.pyc'), 'utf8')).trim(), 'generated');
});

test('remote gateway publish fails closed on stale head or wrong active branch', async (t) => {
  const { repo, config } = await fixture(t);
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  await fs.writeFile(path.join(repo, 'demo.py'), 'x = 3\n');
  await assert.rejects(() => gateway(`publish ${'0'.repeat(40)}`, config), /publish_head_mismatch/);
  await fs.writeFile(path.join(repo, '.project', 'ACTIVE_SPRINT.json'), JSON.stringify({
    selection: { active_work_package: { issue: 42, branch: 'fix/other' } },
  }));
  await assert.rejects(() => gateway(`publish ${before}`, config), /publish_branch_mismatch/);
});


test('remote gateway publish rejects non-cache untracked source', async (t) => {
  const { repo, config } = await fixture(t);
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  await fs.writeFile(path.join(repo, 'demo.py'), 'x = 4\n');
  await fs.writeFile(path.join(repo, 'new_source.py'), 'y = 1\n');
  await assert.rejects(() => gateway(`publish ${before}`, config), /publish_untracked_source/);
});
