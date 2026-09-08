import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStateStore } from '../src/v3/store.mjs';

test('state survives store recreation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { version: 3, projectId: 'demo', status: 'ready', updatedAt: 1 };
  const first = new JsonStateStore(root);
  await first.save('demo', state);
  const second = new JsonStateStore(root);
  assert.deepEqual(await second.load('demo'), state);
});

test('unsafe project ids are rejected', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new JsonStateStore(root);
  await assert.rejects(() => store.save('../escape', { version: 3 }), /unsafe_project_id/);
});
