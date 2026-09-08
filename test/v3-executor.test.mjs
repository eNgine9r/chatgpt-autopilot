import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DeterministicExecutor, runFile } from '../src/v3/executor.mjs';

async function gitRepo(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-repo-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Autopilot Test'], { cwd: root });
  await fs.writeFile(path.join(root, 'README.md'), 'demo\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return root;
}

test('repo.inspect returns bounded read-only git evidence', async (t) => {
  const repoPath = await gitRepo(t);
  const executor = new DeterministicExecutor();
  const evidence = JSON.parse(await executor.execute({ repoPath }, { action: 'repo.inspect', params: {} }));
  assert.match(evidence.head, /^[0-9a-f]{40}$/);
  assert.equal(evidence.cleanTracked, true);
  assert.equal(typeof evidence.branch, 'string');
});

test('repo.test can execute only configured alias argv without shell', async (t) => {
  const repoPath = await gitRepo(t);
  const executor = new DeterministicExecutor();
  const project = {
    repoPath,
    tests: { required: { command: 'node', args: ['-e', 'process.stdout.write("PASS")'], timeoutMs: 1000 } },
  };
  const evidence = JSON.parse(await executor.execute(project, {
    action: 'repo.test', params: { alias: 'required' },
  }));
  assert.equal(evidence.stdout, 'PASS');
  assert.equal(evidence.exitCode, 0);
  await assert.rejects(() => executor.execute(project, {
    action: 'repo.test', params: { alias: 'remote-command' },
  }), /unknown_test_alias/);
});

test('test process environment does not inherit unrelated secrets', async () => {
  process.env.AUTOPILOT_SECRET_TEST = 'must-not-leak';
  try {
    const result = await runFile('node', ['-e', 'process.stdout.write(process.env.AUTOPILOT_SECRET_TEST || "absent")'], {
      cwd: process.cwd(), timeoutMs: 1000,
    });
    assert.equal(result.stdout, 'absent');
  } finally {
    delete process.env.AUTOPILOT_SECRET_TEST;
  }
});

test('test process timeout fails closed', async () => {
  await assert.rejects(() => runFile('node', ['-e', 'setTimeout(() => {}, 2000)'], {
    cwd: process.cwd(), timeoutMs: 100,
  }), /command_timeout/);
});


test('ssh-gateway executor uses fixed ssh argv and remote operation only', async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: JSON.stringify({ ok: true }), stderr: '', exitCode: 0 };
  };
  const project = {
    transport: {
      type: 'ssh-gateway',
      host: 'nexolab-edge-01',
      user: 'nexolab',
      identityFile: '/home/btcradar/.ssh/autopilot-v3-nexolab',
    },
    tests: { required: { remote: true, timeoutMs: 1234 } },
  };
  const executor = new DeterministicExecutor({ runner });
  await executor.execute(project, { action: 'repo.inspect', params: {} });
  await executor.execute(project, { action: 'repo.test', params: { alias: 'required' } });
  assert.equal(calls[0].command, 'ssh');
  assert.equal(calls[0].args.at(-1), 'inspect');
  assert.equal(calls[1].args.at(-1), 'test required');
  assert.ok(calls[0].args.includes('StrictHostKeyChecking=yes'));
  await assert.rejects(() => executor.execute(project, {
    action: 'repo.test', params: { alias: 'required;rm -rf /' },
  }), /unknown_test_alias/);
});
