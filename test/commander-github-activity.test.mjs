import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COMMANDER_ACTIVITY_LIMIT,
  readCommanderActivity,
  writeCommanderActivity,
} from '../src/integrations/github/commander/activity-store.mjs';

test('Commander activity store is atomic bounded and newest-first', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-activity-'));
  const file = path.join(root, 'runtime', 'activity.json');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (let i = 1; i <= COMMANDER_ACTIVITY_LIMIT + 5; i += 1) {
    await writeCommanderActivity(file, {
      issueNumber: i,
      deviceId: i % 2 ? 'btc-radar' : 'nexolab-edge-01',
      operation: i % 2 ? 'terminal.exec' : 'device.health',
      ok: true,
      completedAt: new Date(1_800_000_000_000 + i * 1000).toISOString(),
      state: 'success',
      exitCode: 0,
    });
  }

  const items = await readCommanderActivity(file, COMMANDER_ACTIVITY_LIMIT);
  assert.equal(items.length, COMMANDER_ACTIVITY_LIMIT);
  assert.equal(items[0].issueNumber, COMMANDER_ACTIVITY_LIMIT + 5);
  assert.equal(items.at(-1).issueNumber, 6);
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o077, 0);
});

test('Commander activity store replaces duplicate issue entries and rejects malformed writes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-activity-'));
  const file = path.join(root, 'activity.json');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const base = {
    issueNumber: 10,
    deviceId: 'btc-radar',
    operation: 'device.health',
    ok: true,
    completedAt: '2026-09-18T06:00:00.000Z',
  };
  await writeCommanderActivity(file, base);
  await writeCommanderActivity(file, { ...base, operation: 'terminal.exec', completedAt: '2026-09-18T06:01:00.000Z' });
  const items = await readCommanderActivity(file);
  assert.equal(items.length, 1);
  assert.equal(items[0].operation, 'terminal.exec');

  await assert.rejects(
    writeCommanderActivity(file, { ...base, deviceId: '../unsafe' }),
    /invalid_commander_activity_entry/,
  );
});
