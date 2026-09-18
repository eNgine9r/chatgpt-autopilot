import test from 'node:test';
import assert from 'node:assert/strict';
import { operationDefinition, protocolEnvelope } from '../src/commander/contracts/index.mjs';
import {
  commanderRequestFromGithubTask,
  executeCommanderGithubTask,
  githubBridgeComment,
  githubBridgeFailure,
  parseAllowedOperations,
  parseCommanderGithubTask,
} from '../src/integrations/github/commander/bridge.mjs';
import { runGithubBridgeCycle, waitForNextPoll } from '../src/integrations/github/commander/service.mjs';

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


test('GitHub bridge normalizes contract-validation errors into valid protocol error codes', () => {
  const failure = githubBridgeFailure(321, Object.assign(new Error('invalid_string:error.code'), { code: 'invalid_string' }));
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'INVALID_STRING');
  assert.equal(failure.error.retryable, false);
});

test('GitHub bridge cycle isolates a malformed task result and continues with later tasks', async () => {
  const first = issue({ version: 1, deviceId: 'btc-radar', operation: 'device.health', params: {} });
  const second = issue(
    { version: 1, deviceId: 'btc-radar', operation: 'device.health', params: {} },
    { number: 322 },
  );
  const comments = [];
  const closed = [];
  const github = {
    listOpenTasks: async () => [first, second],
    addComment: async (number, body) => comments.push([number, body]),
    closeIssue: async (number) => closed.push(number),
  };
  let requests = 0;
  const client = {
    getDevice: async () => snapshot('device.health'),
    request: async (request) => {
      requests += 1;
      if (requests === 1) {
        return {
          ...protocolEnvelope(), requestId: request.requestId, deviceId: request.deviceId,
          operation: request.operation, ok: false, completedAt: NOW,
          error: { ...protocolEnvelope(), category: 'validation', code: '', message: 'bad', retryable: false },
        };
      }
      return okResult(request);
    },
  };
  const outcome = await runGithubBridgeCycle({ config: config(), github, client, logger: { info() {}, warn() {} } });
  assert.deepEqual(outcome, { seen: 2, completed: 2 });
  assert.deepEqual(closed, [321, 322]);
  assert.equal(comments.length, 2);
  assert.match(comments[0][1], /"code":"INVALID_STRING"/);
  assert.match(comments[1][1], /"ok":true/);
});

test('GitHub bridge result comments are bounded plain JSON', () => {
  const body = githubBridgeComment({ ok: true, data: { value: 1 } });
  assert.match(body, /^<!-- commander-result:v1 -->\n/);
  assert.match(body, /\"value\":1/);
});



test('GitHub bridge accepts bounded terminal.exec workflows and requires idempotency', () => {
  const terminalConfig = config('device.health,terminal.exec');
  const body = {
    version: 1, deviceId: 'btc-radar', operation: 'terminal.exec',
    params: { command: 'echo hello' }, timeoutMs: 120_000,
  };
  assert.throws(() => parseCommanderGithubTask(issue(body), terminalConfig), /github_task_idempotency_required/);
  const accepted = parseCommanderGithubTask(issue({ ...body, idempotencyKey: 'terminal-321' }), terminalConfig);
  assert.equal(accepted.operation, 'terminal.exec');
  assert.equal(accepted.params.command, 'echo hello');
  assert.equal(accepted.timeoutMs, 120_000);
  assert.throws(() => parseCommanderGithubTask(issue({
    ...body, timeoutMs: 120_001, idempotencyKey: 'terminal-too-long',
  }), terminalConfig), /invalid_github_task_timeout/);
  assert.throws(() => parseCommanderGithubTask(issue({
    ...body, params: { command: 'echo hello', alias: 'other' }, idempotencyKey: 'terminal-extra',
  }), terminalConfig), /invalid_github_terminal_params/);
});

test('GitHub bridge terminal.exec performs start input get output in one task', async () => {
  const operations = [];
  const caps = ['execution.start', 'execution.input', 'execution.get', 'execution.output'];
  const client = {
    getDevice: async () => ({
      status: 'online',
      device: {
        ...protocolEnvelope(), deviceId: 'btc-radar', displayName: 'btc-radar', platform: 'linux',
        agentVersion: '0.1.0', sessionId: 'session-terminal', connectedAt: NOW,
        capabilities: caps.map(capability),
      },
    }),
    request: async (request) => {
      operations.push(request);
      const base = {
        ...protocolEnvelope(), requestId: request.requestId, deviceId: request.deviceId,
        operation: request.operation, ok: true, completedAt: NOW,
      };
      if (request.operation === 'execution.start') {
        return { ...base, data: { execution: { executionId: 'exec-terminal-1', state: 'running' } } };
      }
      if (request.operation === 'execution.input') {
        return { ...base, data: { executionId: 'exec-terminal-1', acceptedBytes: request.params.data.length } };
      }
      if (request.operation === 'execution.get') {
        return { ...base, data: { execution: { executionId: 'exec-terminal-1', state: 'success', exitCode: 0 } } };
      }
      if (request.operation === 'execution.output') {
        return {
          ...base,
          data: {
            events: [
              { type: 'stdout', payload: { chunk: 'hello\\n' } },
              { type: 'stderr', payload: { chunk: 'warn\\n' } },
            ],
            truncated: false,
            totalBytes: 11,
          },
        };
      }
      assert.fail(`unexpected operation ${request.operation}`);
    },
  };
  const result = await executeCommanderGithubTask({
    issue: issue({
      version: 1, deviceId: 'btc-radar', operation: 'terminal.exec',
      params: { command: 'echo hello' }, timeoutMs: 10_000, idempotencyKey: 'terminal-workflow-1',
    }),
    config: config('terminal.exec'),
    client,
  });
  assert.equal(result.ok, true);
  assert.equal(result.workflow, 'terminal.exec');
  assert.equal(result.data.state, 'success');
  assert.equal(result.data.exitCode, 0);
  assert.equal(result.data.stdout, 'hello\\n');
  assert.equal(result.data.stderr, 'warn\\n');
  assert.deepEqual(operations.map((request) => request.operation), [
    'execution.start', 'execution.input', 'execution.get', 'execution.output',
  ]);
  assert.deepEqual(operations[0].params, { alias: 'operator.shell' });
  assert.match(operations[0].idempotencyKey, /^ghwf-321-start-/);
  assert.match(operations[1].idempotencyKey, /^ghwf-321-input-/);
  assert.equal(operations[1].params.data, 'echo hello\nexit\n');
});

test('GitHub bridge terminal.exec fails closed when an execution capability is missing', async () => {
  const client = {
    getDevice: async () => ({
      status: 'online',
      device: {
        ...protocolEnvelope(), deviceId: 'btc-radar', displayName: 'btc-radar', platform: 'linux',
        agentVersion: '0.1.0', sessionId: 'session-terminal', connectedAt: NOW,
        capabilities: ['execution.start', 'execution.get', 'execution.output'].map(capability),
      },
    }),
    request: async () => assert.fail('must not dispatch partial terminal workflow'),
  };
  await assert.rejects(() => executeCommanderGithubTask({
    issue: issue({
      version: 1, deviceId: 'btc-radar', operation: 'terminal.exec',
      params: { command: 'echo hello' }, timeoutMs: 10_000, idempotencyKey: 'terminal-capability-check',
    }),
    config: config('terminal.exec'),
    client,
  }), /github_bridge_operation_not_advertised/);
});

test('GitHub bridge poll timer stays referenced so an idle service remains alive', async () => {
  let unrefCalled = false;
  const schedule = (callback) => {
    queueMicrotask(callback);
    return { unref() { unrefCalled = true; throw new Error('poll timer must stay referenced'); } };
  };
  await waitForNextPoll(10_000, undefined, schedule);
  assert.equal(unrefCalled, false);
});
