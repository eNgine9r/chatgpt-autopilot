import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TelegramBridge,
  TelegramBridgeStateStore,
  isAuthorized,
  parseTelegramCommand,
} from '../src/v3/telegram-bridge.mjs';

const config = {
  version: 3,
  projects: [{
    id: 'demo', enabled: true,
    steps: [
      { id: 'inspect', action: 'repo.inspect' },
      { id: 'review', action: 'operator.review', approval: 'user' },
    ],
  }],
};

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-telegram-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, store: new TelegramBridgeStateStore(path.join(dir, 'telegram.json')) };
}
test('Telegram command parsing and owner authorization fail closed', () => {
  assert.deepEqual(parseTelegramCommand('/status'), { kind: 'status' });
  assert.deepEqual(parseTelegramCommand('/v3@autopilot_bot'), { kind: 'status' });
  assert.deepEqual(parseTelegramCommand('/approve demo'), { kind: 'approve', projectId: 'demo' });
  assert.deepEqual(parseTelegramCommand('/retry bad id'), null);
  assert.deepEqual(parseTelegramCommand('/approve'), { kind: 'invalid', command: 'approve' });

  const message = { from: { id: 100 }, chat: { id: 200 } };
  assert.equal(isAuthorized(message, '100', '200'), true);
  assert.equal(isAuthorized(message, '101', '200'), false);
  assert.equal(isAuthorized(message, '100', '201'), false);
});

test('state notifications are deduplicated and survive store recreation', async (t) => {
  const f = await fixture(t);
  const sent = [];
  let projects = [{
    projectId: 'demo', status: 'waiting_approval', stepIndex: 1,
    task: { id: 'task-1', title: 'Need approval' }, lastError: '',
  }];
  const telegram = { sendMessage: async (_chat, text) => { sent.push(text); return true; } };
  const localApi = { getProjects: async () => projects };
  const bridge = new TelegramBridge({ config, store: f.store, telegram, localApi, ownerUserId: '100', chatId: '200' });
  await bridge.scanStates();
  await bridge.scanStates();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /очікує підтвердження/);

  projects = [{ ...projects[0], status: 'complete', stepIndex: 2 }];
  await bridge.scanStates();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /завершено/);

  const reloaded = new TelegramBridge({
    config, store: new TelegramBridgeStateStore(path.join(f.dir, 'telegram.json')),
    telegram, localApi, ownerUserId: '100', chatId: '200',
  });
  await reloaded.scanStates();
  assert.equal(sent.length, 2);
  const stat = await fs.stat(path.join(f.dir, 'telegram.json'));
  assert.equal(stat.mode & 0o777, 0o600);
});

test('first scan baselines completed projects without startup spam', async (t) => {
  const f = await fixture(t);
  const sent = [];
  const projects = [{ projectId: 'demo', status: 'complete', stepIndex: 2, task: { id: 'done' }, lastError: '' }];
  const bridge = new TelegramBridge({
    config, store: f.store,
    telegram: { sendMessage: async (_chat, text) => { sent.push(text); return true; } },
    localApi: { getProjects: async () => projects }, ownerUserId: '100', chatId: '200',
  });
  await bridge.scanStates();
  await bridge.scanStates();
  assert.equal(sent.length, 0);
  const saved = await f.store.load();
  assert.match(saved.notified.demo, /^complete\|done\|2\|/);
});

test('authorized approve command is state-gated and persists update offset', async (t) => {
  const f = await fixture(t);
  const sent = [];
  const posted = [];
  const projects = [{
    projectId: 'demo', status: 'waiting_approval', stepIndex: 1,
    task: { id: 'task-2', title: 'Approve me' }, lastError: '',
  }];
  const bridge = new TelegramBridge({
    config, store: f.store,
    telegram: { sendMessage: async (_chat, text) => { sent.push(text); return true; } },
    localApi: {
      getProjects: async () => projects,
      postEvent: async (event) => { posted.push(event); return { ok: true }; },
    },
    ownerUserId: '100', chatId: '200',
  });
  await bridge.processUpdates([{
    update_id: 10,
    message: { from: { id: 100 }, chat: { id: 200 }, text: '/approve demo' },
  }]);
  assert.deepEqual(posted, [{
    id: 'telegram:10:approve:demo',
    projectId: 'demo',
    kind: 'approval.granted',
    stepId: 'review',
  }]);
  assert.match(sent[0], /підтвердження прийнято/);
  assert.equal((await f.store.load()).offset, 11);

  projects[0] = { ...projects[0], status: 'complete', stepIndex: 2 };
  await bridge.processUpdates([{
    update_id: 11,
    message: { from: { id: 100 }, chat: { id: 200 }, text: '/approve demo' },
  }]);
  assert.equal(posted.length, 1);
  assert.match(sent.at(-1), /approval недоступний/);
});

test('retry is allowed only for blocked state and unauthorized updates are ignored', async (t) => {
  const f = await fixture(t);
  const sent = [];
  const posted = [];
  const projects = [{ projectId: 'demo', status: 'blocked', stepIndex: 0, task: { id: 't' }, lastError: 'boom' }];
  const bridge = new TelegramBridge({
    config, store: f.store,
    telegram: { sendMessage: async (_chat, text) => { sent.push(text); return true; } },
    localApi: {
      getProjects: async () => projects,
      postEvent: async (event) => { posted.push(event); return { ok: true }; },
    },
    ownerUserId: '100', chatId: '200',
  });

  await bridge.processUpdates([
    { update_id: 20, message: { from: { id: 999 }, chat: { id: 200 }, text: '/retry demo' } },
    { update_id: 21, message: { from: { id: 100 }, chat: { id: 200 }, text: '/retry demo' } },
  ]);
  assert.deepEqual(posted, [{
    id: 'telegram:21:retry:demo',
    projectId: 'demo',
    kind: 'retry',
  }]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /retry запущено/);
  assert.equal((await f.store.load()).offset, 22);
});
