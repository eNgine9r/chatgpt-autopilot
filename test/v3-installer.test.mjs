import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function run(file, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function mode(file) {
  return (await fs.stat(file)).mode & 0o777;
}

test('v3 installer renders secret path and preserves private secret', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-install-'));
  const repo = path.join(root, 'repo');
  const fakebin = path.join(root, 'bin');
  const xdg = path.join(root, 'xdg');
  await fs.mkdir(path.join(repo, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(repo, 'systemd'), { recursive: true });
  await fs.mkdir(path.join(repo, 'config'), { recursive: true });
  await fs.mkdir(fakebin, { recursive: true });

  const installer = path.join(repo, 'scripts', 'install-v3-systemd.sh');
  await fs.copyFile(new URL('../scripts/install-v3-systemd.sh', import.meta.url), installer);
  await fs.copyFile(
    new URL('../systemd/chatgpt-autopilot-v3.service.template', import.meta.url),
    path.join(repo, 'systemd', 'chatgpt-autopilot-v3.service.template'),
  );
  await fs.copyFile(
    new URL('../config/v3-projects.example.json', import.meta.url),
    path.join(repo, 'config', 'v3-projects.example.json'),
  );
  await fs.chmod(installer, 0o755);

  const systemctlLog = path.join(root, 'systemctl.log');
  const fakeSystemctl = path.join(fakebin, 'systemctl');
  await fs.writeFile(fakeSystemctl, '#!/bin/sh\nprintf "%s|%s|%s\\n" "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" "$*" >> "$SYSTEMCTL_LOG"\n');
  await fs.chmod(fakeSystemctl, 0o755);

  const env = {
    PATH: `${fakebin}:${process.env.PATH}`,
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: xdg,
    SYSTEMCTL_LOG: systemctlLog,
  };
  await fs.mkdir(env.HOME, { recursive: true });

  const first = await run(installer, env);
  assert.equal(first.code, 0, first.stderr);

  const secretFile = path.join(repo, 'state-v3', 'github-webhook.secret');
  const unitFile = path.join(xdg, 'systemd', 'user', 'chatgpt-autopilot-v3.service');
  const firstSecret = await fs.readFile(secretFile, 'utf8');
  const unit = await fs.readFile(unitFile, 'utf8');
  assert.match(firstSecret, /^[0-9a-f]{64}$/);
  assert.equal(await mode(secretFile), 0o600);
  assert.equal(await mode(unitFile), 0o600);
  assert.ok(unit.includes(`AUTOPILOT_V3_GITHUB_SECRET_FILE=${secretFile}`));
  assert.equal(unit.includes('__GITHUB_SECRET_FILE__'), false);
  assert.equal(unit.includes('__REPO_DIR__'), false);
  assert.equal(unit.includes('__NODE_BIN__'), false);

  const second = await run(installer, env);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(await fs.readFile(secretFile, 'utf8'), firstSecret);
  const calls = (await fs.readFile(systemctlLog, 'utf8')).trim().split('\n');
  const runtime = `/run/user/${process.getuid()}`;
  const expected = `${runtime}|unix:path=${runtime}/bus|--user daemon-reload`;
  assert.deepEqual(calls, [expected, expected]);
  assert.equal(calls.some((line) => /start|enable/.test(line)), false);

  await fs.rm(root, { recursive: true, force: true });
});
