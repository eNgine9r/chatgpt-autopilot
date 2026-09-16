import test from 'node:test';
import assert from 'node:assert/strict';
import { operationDefinition, protocolEnvelope } from '../src/commander/contracts/index.mjs';
import {
  commanderRequestFromGithubTask,
  executeCommanderGithubTask,
  githubBridgeComment,
  parseAllowedOperations,
  parseCommanderGithubTask,
} from '../src/integrations/github/commander/bridge.mjs';
import { runGithubBridgeCycle } from '../src/integrations/github/commander/service.mjs';

const NOW = '2026-09-16T18:00:00Z';

function capability(operation) {
  const definition = operationDefinition(operation);
  return { operation, authority: definition.authority, operationVersion: definition.operationVersion };
}

function issue(body, overrides = {}) {
  return {
    number: 321,
    body: JSON.stringify(body),
    user: { login: 'eNgine9r' },
    author_association: 'OWNER',
    ...overrides,
  };
}

function config(operations = 'device.health,execution.start') {
  return { allowedAuthor: 'eNgine9r', allowedOperations: parseAllowedOperations(operations), taskLabel: 'commander/task', maxIssues: 10 };
}
function snapshot(operation) {
  return {
    status: 'online',
    device: {
      ...protocolEnvelope(), deviceId: 'btc-radar', displayName: 'btc-radar', platform: 'linux',
      agentVersion: '0.1.0', sessionId: 'session-a', connectedAt: NOW,
      capabilities: [capability(operation)],
    },
  };
}

function okResult(request) {
  return {
    ...protocolEnvelope(), requestId: request.requestId, deviceId: request.deviceId,
    operation: request.operation, ok: true, completedAt: NOW, data: { accepted: true },
  };
}

test('GitHub bridge parses a bounded owner-authored read task', () => {
  const raw = issue({ version: 1, deviceId: 'btc-radar', operation: 'device.health', params: {} });
  const task = parseCommanderGithubTask(raw, config());
  assert.equal(task.deviceId, 'btc-radar');
  assert.equal(task.operation, 'device.health');
  assert.equal(task.timeoutMs, 10_000);
  const request = commanderRequestFromGithubTask(task);
  assert.equal(request.deviceId, 'btc-radar');
  assert.match(request.requestId, /^github-321-/);
  assert.equal(request.operation, 'device.health');
});
test('GitHub bridge rejects non-owner tasks and unapproved operations', () => {
  const readTask = { version: 1, deviceId: 'btc-radar', operation: 'device.health', params: {} };
  assert.throws(
    () => parseCommanderGithubTask(issue(readTask, { user: { login: 'attacker' }, author_association: 'NONE' }), config()),
    /github_bridge_author_denied/,
  );
  const denied = issue({ version: 1, deviceId: 'btc-radar', operation: 'file.write', params: { path: '/tmp/x', content: 'x' }, idempotencyKey: 'idem-1' });
  assert.throws(() => parseCommanderGithubTask(denied, config()), /github_bridge_operation_denied/);
});

test('GitHub bridge requires idempotency for mutating operations', () => {
  const task = issue({ version: 1, deviceId: 'btc-radar', operation: 'execution.start', params: { alias: 'required' } });
  assert.throws(() => parseCommanderGithubTask(task, config()), /github_task_idempotency_required/);
  const accepted = parseCommanderGithubTask(issue({
    version: 1, deviceId: 'btc-radar', operation: 'execution.start',
    params: { alias: 'required' }, idempotencyKey: 'issue-321-attempt-1',
  }), config());
  assert.equal(accepted.idempotencyKey, 'issue-321-attempt-1');
});

test('GitHub bridge rechecks the live advertised capability before forwarding', async () => {
  const requests = [];
  const client = {
    getDevice: async () => snapshot('device.health'),
    request: async (request) => { requests.push(request); return okResult(request); },
  };
  const result = await executeCommanderGithubTask({
    issue: issue({ version: 1, deviceId: 'btc-radar', operation: 'device.health', params: {} }),
    config: config(), client,
  });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].operation, 'device.health');

  const offlineClient = { getDevice: async () => ({ status: 'offline' }), request: async () => assert.fail('must not forward') };
  await assert.rejects(() => executeCommanderGithubTask({
    issue: issue({ version: 1, deviceId: 'btc-radar', operation: 'device.health', params: {} }),
    config: config(), client: offlineClient,
  }), /github_bridge_operation_not_advertised/);
});

test('GitHub bridge cycle comments and closes a completed issue', async () => {
  const comments = [];
  const closed = [];
  const taskIssue = issue({ version: 1, deviceId: 'btc-radar', operation: 'device.health', params: {} });
  const github = {
    listOpenTasks: async () => [taskIssue],
    addComment: async (number, body) => comments.push([number, body]),
    closeIssue: async (number) => closed.push(number),
  };
  const client = { getDevice: async () => snapshot('device.health'), request: async (request) => okResult(request) };
  const outcome = await runGithubBridgeCycle({ config: config(), github, client, logger: { info() {}, warn() {} } });
  assert.deepEqual(outcome, { seen: 1, completed: 1 });
  assert.deepEqual(closed, [321]);
  assert.equal(comments.length, 1);
  assert.match(comments[0][1], /commander-result:v1/);
  assert.match(comments[0][1], /\"ok\":true/);
});

test('GitHub bridge cycle leaves retryable Commander transport failures open', async () => {
  const taskIssue = issue({ version: 1, deviceId: 'btc-radar', operation: 'device.health', params: {} });
  const github = {
    listOpenTasks: async () => [taskIssue],
    addComment: async () => assert.fail('retry must not comment terminal result'),
    closeIssue: async () => assert.fail('retry must not close issue'),
  };
  const client = { getDevice: async () => { throw new Error('control_request_timeout'); } };
  const outcome = await runGithubBridgeCycle({ config: config(), github, client, logger: { info() {}, warn() {} } });
  assert.deepEqual(outcome, { seen: 1, completed: 0 });
});

test('GitHub bridge result comments are bounded plain JSON', () => {
  const body = githubBridgeComment({ ok: true, data: { value: 1 } });
  assert.match(body, /^<!-- commander-result:v1 -->\n/);
  assert.match(body, /\"value\":1/);
});
