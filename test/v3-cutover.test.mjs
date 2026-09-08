import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const script = new URL('../scripts/v3-webhook-cutover.py', import.meta.url).pathname;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-cutover-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const config = path.join(root, 'projects.json');
  const secretFile = path.join(root, 'secret');
  const log = path.join(root, 'calls.log');
  const stdinLog = path.join(root, 'stdin.log');
  const secret = 's'.repeat(40);
  await fs.writeFile(config, JSON.stringify({
    version: 3,
    projects: [{
      id: 'demo', enabled: true,
      github: { repository: 'eNgine9r/demo', taskLabels: ['autopilot'] },
      tests: {}, steps: [{ id: 'review', action: 'operator.review', approval: 'user' }],
    }],
  }));
  await fs.writeFile(secretFile, secret, { mode: 0o600 });
  return { root, bin, config, secretFile, secret, log, stdinLog };
}

async function writeExe(file, body) {
  await fs.writeFile(file, body, { mode: 0o755 });
}

async function installFakes(f) {
  await writeExe(path.join(f.bin, 'tailscale'), `#!/bin/sh
printf 'tailscale %s\\n' "$*" >> "$CALL_LOG"
if [ "$1 $2 $3" = "funnel status --json" ]; then printf '{}'; fi
`);
  await writeExe(path.join(f.bin, 'gh'), `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
case "$1 $2" in
  'api repos/'*) printf '%s' "\${GH_HOOKS:-[]}" ;;
  'label list') printf '[]' ;;
  'api --method') if [ "$3" != "DELETE" ]; then cat >> "$STDIN_LOG"; fi; printf '{}';;
  *) : ;;
esac
`);
  await writeExe(path.join(f.bin, 'systemctl'), `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$CALL_LOG"
`);
}

async function runCutover(f, { apply = false, rollback = false, extraEnv = {} } = {}) {
  const args = [
    script,
    '--config', f.config,
    '--secret-file', f.secretFile,
    '--base-url', 'https://example.test',
  ];
  if (apply) args.push('--apply');
  if (rollback) args.push('--rollback');
  return execFileAsync('python3', args, {
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      CALL_LOG: f.log,
      STDIN_LOG: f.stdinLog,
      ...extraEnv,
    },
  });
}

test('v3 cutover is dry-run by default and redacts the secret', async (t) => {
  const f = await fixture(t);
  await installFakes(f);
  const result = await runCutover(f);
  const report = JSON.parse(result.stdout);
  assert.equal(report.apply, false);
  assert.equal(report.callbackUrl, 'https://example.test/autopilot-v3-github');
  assert.equal(report.projects[0].hookAction, 'create');
  assert.deepEqual(report.projects[0].missingLabels, ['autopilot']);
  assert.equal(result.stdout.includes(f.secret), false);
  const calls = await fs.readFile(f.log, 'utf8');
  assert.equal(calls.includes('--method POST'), false);
  assert.equal(calls.includes('label create'), false);
  assert.equal(calls.includes('systemctl'), false);
  assert.equal(calls.includes(f.secret), false);
});

test('v3 cutover apply sends hook secret through stdin only', async (t) => {
  const f = await fixture(t);
  await installFakes(f);
  const result = await runCutover(f, { apply: true });
  assert.equal(result.stdout.includes(f.secret), false);
  const calls = await fs.readFile(f.log, 'utf8');
  assert.match(calls, /tailscale funnel --bg --yes --set-path=\/autopilot-v3-github/);
  assert.match(calls, /gh label create autopilot/);
  assert.match(calls, /gh api --method POST/);
  assert.match(calls, /systemctl --user enable --now chatgpt-autopilot-v3.service/);
  assert.equal(calls.includes(f.secret), false);
  const stdin = await fs.readFile(f.stdinLog, 'utf8');
  assert.ok(stdin.includes(f.secret));
});

test('v3 cutover reuses an existing callback hook instead of duplicating it', async (t) => {
  const f = await fixture(t);
  await installFakes(f);
  const hooks = JSON.stringify([{ id: 99, config: { url: 'https://example.test/autopilot-v3-github' } }]);
  const result = await runCutover(f, { apply: true, extraEnv: { GH_HOOKS: hooks } });
  const report = JSON.parse(result.stdout);
  assert.equal(report.projects[0].hookAction, 'update');
  assert.equal(report.projects[0].hookId, 99);
  const calls = await fs.readFile(f.log, 'utf8');
  assert.match(calls, /gh api --method PATCH repos\/eNgine9r\/demo\/hooks\/99 --input -/);
  assert.equal(calls.includes('gh api --method POST repos/eNgine9r/demo/hooks --input -'), false);
});

test('v3 rollback removes only the parallel hook/path and disables v3 without a secret', async (t) => {
  const f = await fixture(t);
  await installFakes(f);
  await fs.unlink(f.secretFile);
  const hooks = JSON.stringify([{ id: 77, config: { url: 'https://example.test/autopilot-v3-github' } }]);
  const result = await runCutover(f, { apply: true, rollback: true, extraEnv: { GH_HOOKS: hooks } });
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'rollback');
  assert.equal(report.projects[0].hookAction, 'delete');
  const calls = await fs.readFile(f.log, 'utf8');
  assert.match(calls, /gh api --method DELETE repos\/eNgine9r\/demo\/hooks\/77/);
  assert.match(calls, /tailscale funnel --yes --set-path=\/autopilot-v3-github off/);
  assert.match(calls, /systemctl --user disable --now chatgpt-autopilot-v3.service/);
  assert.equal(calls.includes('label create'), false);
  assert.equal(calls.includes('autopilot-events'), false);
});

test('v3 cutover rejects non-HTTPS or path-bearing base URLs', async (t) => {
  const f = await fixture(t);
  await installFakes(f);
  const bad = await execFileAsync('python3', [
    script, '--config', f.config, '--secret-file', f.secretFile,
    '--base-url', 'http://example.test/path',
  ], {
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, CALL_LOG: f.log, STDIN_LOG: f.stdinLog },
  }).then(() => null, (error) => error);
  assert.ok(bad);
  assert.match(bad.stderr, /invalid_base_url/);
});
