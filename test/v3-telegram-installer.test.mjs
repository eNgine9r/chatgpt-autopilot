import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('Telegram installer stages a private disabled unit only', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-tg-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  const xdg = path.join(root, 'xdg');
  await fs.mkdir(path.join(repo, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(repo, 'systemd'), { recursive: true });
  await fs.mkdir(path.join(repo, 'config'), { recursive: true });
  await fs.mkdir(bin, { recursive: true });

  const installer = path.join(repo, 'scripts', 'install-v3-telegram-systemd.sh');
  await fs.copyFile(new URL('../scripts/install-v3-telegram-systemd.sh', import.meta.url), installer);
  await fs.copyFile(
    new URL('../systemd/chatgpt-autopilot-v3-telegram.service.template', import.meta.url),
    path.join(repo, 'systemd', 'chatgpt-autopilot-v3-telegram.service.template'),
  );
  await fs.chmod(installer, 0o755);
  await fs.writeFile(path.join(repo, '.env'), [
    'TELEGRAM_BOT_TOKEN=test-token-12345678901234567890',
    'TELEGRAM_CHAT_ID=200',
    'TELEGRAM_OWNER_USER_ID=100',
    '',
  ].join('\n'), { mode: 0o600 });
  await fs.writeFile(
    path.join(repo, 'config', 'v3-projects.json'),
    JSON.stringify({ version: 3, projects: [] }),
    { mode: 0o600 },
  );

  const log = path.join(root, 'systemctl.log');
  const fake = path.join(bin, 'systemctl');
  await fs.writeFile(fake, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\n', { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: xdg,
    SYSTEMCTL_LOG: log,
    PATH: `${bin}:${process.env.PATH}`,
  };
  await fs.mkdir(env.HOME, { recursive: true });

  const result = await execFileAsync('bash', [installer], { env });
  assert.match(result.stdout, /disabled, not started/);
  const unit = path.join(xdg, 'systemd', 'user', 'chatgpt-autopilot-v3-telegram.service');
  const text = await fs.readFile(unit, 'utf8');
  assert.equal(text.includes('__REPO_DIR__'), false);
  assert.equal(text.includes('__NODE_BIN__'), false);
  assert.match(text, /src\/v3\/telegram-service\.mjs/);
  assert.equal((await fs.stat(unit)).mode & 0o777, 0o600);

  const calls = (await fs.readFile(log, 'utf8')).trim().split('\n');
  assert.deepEqual(calls, ['--user daemon-reload']);
  assert.equal(calls.some((line) => /\b(start|enable)\b/.test(line)), false);
});
