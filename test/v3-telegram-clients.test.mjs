import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalV3Client, createTelegramClient } from '../src/v3/telegram-clients.mjs';

test('Telegram client keeps token out of surfaced transport errors', async () => {
  const token = '1234567890:abcdefghijklmnopqrstuvwxyz';
  const client = createTelegramClient({
    token,
    fetchImpl: async () => { throw new Error(`network ${token}`); },
  });
  await assert.rejects(
    () => client.sendMessage('42', 'hello'),
    (error) => {
      assert.equal(String(error).includes(token), false);
      assert.match(error.message, /telegram_sendMessage_transport_failed/);
      return true;
    },
  );
});

test('Telegram client posts bounded Bot API method bodies through injected fetch', async () => {
  const calls = [];
  const client = createTelegramClient({
    token: '1234567890:abcdefghijklmnopqrstuvwxyz',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
    },
  });
  await client.getUpdates(17);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/getUpdates$/);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, { offset: 17, timeout: 20, allowed_updates: ['message'] });
});

test('local v3 client is loopback-only and posts fixed event endpoint', async () => {
  assert.throws(
    () => createLocalV3Client({ base: 'http://example.test:8780' }),
    /invalid_local_v3_base/,
  );
  const calls = [];
  const client = createLocalV3Client({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      const payload = url.endsWith('/projects') ? { projects: [] } : { ok: true };
      return { ok: true, status: 200, json: async () => payload };
    },
  });
  assert.deepEqual(await client.getProjects(), []);
  await client.postEvent({ id: 'evt-1', kind: 'retry' });
  assert.equal(calls[0].url, 'http://127.0.0.1:8780/projects');
  assert.equal(calls[1].url, 'http://127.0.0.1:8780/events');
  assert.equal(calls[1].options.method, 'POST');
});
