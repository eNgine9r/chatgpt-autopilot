import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { translateGitHubEvent, verifyGitHubSignature } from '../src/v3/github-webhook.mjs';
import { JsonStateStore } from '../src/v3/store.mjs';
import { Orchestrator } from '../src/v3/orchestrator.mjs';

const config = {
  version: 3,
  projects: [{
    id: 'demo',
    enabled: true,
    github: { repository: 'eNgine9r/demo', taskLabels: ['autopilot'] },
    steps: [{ id: 'review', action: 'operator.review', approval: 'user' }],
  }],
};

function payload(overrides = {}) {
  return {
    action: 'opened',
    repository: { full_name: 'eNgine9r/demo' },
    issue: {
      number: 42,
      title: 'Do the deterministic thing',
      html_url: 'https://github.com/eNgine9r/demo/issues/42',
      labels: [{ name: 'autopilot' }],
    },
    ...overrides,
  };
}test('GitHub HMAC verification accepts exact body and rejects tampering', () => {
  const secret = '0123456789abcdef0123456789abcdef';
  const body = Buffer.from(JSON.stringify(payload()));
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyGitHubSignature(secret, body, signature), true);
  assert.equal(verifyGitHubSignature(secret, Buffer.from(`${body}x`), signature), false);
  assert.equal(verifyGitHubSignature('', body, signature), false);
  assert.equal(verifyGitHubSignature(secret, body, 'sha256=bad'), false);
});

test('configured labelled issue becomes one bounded v3 task event', () => {
  const translated = translateGitHubEvent(config, 'issues', 'delivery-1', payload());
  assert.equal(translated.ignored, false);
  assert.equal(translated.event.id, 'github:delivery-1');
  assert.equal(translated.event.projectId, 'demo');
  assert.equal(translated.event.kind, 'task.received');
  assert.equal(translated.event.task.id, 'github:eNgine9r/demo#42');
  assert.equal(translated.event.task.issueNumber, 42);
});

test('cross-repository, unlabelled and unsupported events are ignored', () => {
  assert.equal(translateGitHubEvent(config, 'issues', 'd1', payload({
    repository: { full_name: 'other/repo' },
  })).reason, 'repository_not_configured');
  assert.equal(translateGitHubEvent(config, 'issues', 'd2', payload({
    issue: { ...payload().issue, labels: [] },
  })).reason, 'task_label_missing');
  assert.equal(translateGitHubEvent(config, 'pull_request', 'd3', payload()).reason, 'unsupported_event');
  assert.equal(translateGitHubEvent(config, 'issues', '', payload()).reason, 'invalid_delivery_id');
});test('translated payload fields are clipped to bounded sizes', () => {
  const translated = translateGitHubEvent(config, 'issues', 'delivery-clip', payload({
    issue: {
      ...payload().issue,
      title: 'x'.repeat(1000),
      html_url: `https://example.test/${'y'.repeat(1000)}`,
    },
  }));
  assert.equal(translated.event.task.title.length, 300);
  assert.equal(translated.event.task.url.length, 500);
});

test('duplicate GitHub delivery is idempotent in durable orchestrator state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-github-'));
  try {
    const store = new JsonStateStore(dir);
    await store.init();
    const orchestrator = new Orchestrator(config, store);
    const translated = translateGitHubEvent(config, 'issues', 'delivery-dupe', payload());
    const first = await orchestrator.handle(translated.event);
    const second = await orchestrator.handle(translated.event);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.state.task.id, 'github:eNgine9r/demo#42');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('labeled event triggers only when the applied label is a configured task label', () => {
  const accepted = translateGitHubEvent(config, 'issues', 'label-good', payload({
    action: 'labeled',
    label: { name: 'autopilot' },
  }));
  assert.equal(accepted.ignored, false);

  const ignored = translateGitHubEvent(config, 'issues', 'label-other', payload({
    action: 'labeled',
    label: { name: 'priority-high' },
  }));
  assert.equal(ignored.ignored, true);
  assert.equal(ignored.reason, 'task_label_not_applied');
});

test('opened and labeled deliveries for the same issue collapse to one active task', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-v3-github-race-'));
  try {
    const store = new JsonStateStore(dir);
    await store.init();
    const orchestrator = new Orchestrator(config, store);
    const opened = translateGitHubEvent(config, 'issues', 'race-opened', payload());
    const labeled = translateGitHubEvent(config, 'issues', 'race-labeled', payload({
      action: 'labeled', label: { name: 'autopilot' },
    }));
    const first = await orchestrator.handle(opened.event);
    const second = await orchestrator.handle(labeled.event);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.state.task.id, 'github:eNgine9r/demo#42');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
