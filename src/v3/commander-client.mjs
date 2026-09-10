import crypto from 'node:crypto';
import {
  operationDefinition,
  protocolEnvelope,
  validateCommanderError,
  validateOperationResult,
} from '../commander/contracts/index.mjs';

const TERMINAL = new Set(['success', 'failed', 'cancelled', 'timeout', 'device_offline', 'requires_approval']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedText(value, limit = 12000) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

function requestId(operation) {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 20);
  return `v3-${operation.replaceAll('.', '-')}-${suffix}`;
}

function stableMutationKey(project, dispatch, suffix = '') {
  const seed = [project.id, dispatch.taskId ?? 'task', dispatch.stepId, dispatch.attempt ?? 1, dispatch.action, suffix].join(':');
  return `v3-${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

function normalizedBranch(value) {
  return String(value ?? '').split('...')[0].split(' ')[0];
}

function commanderFailure(error, context = {}) {
  let structured = null;
  if (error?.commanderError) {
    try { structured = validateCommanderError(error.commanderError); } catch { structured = null; }
  }
  const category = structured?.category || (error?.code === 'control_request_timeout' ? 'timeout' : 'transport');
  const code = structured?.code || (category === 'timeout' ? 'COMMANDER_CONTROL_TIMEOUT' : 'COMMANDER_UNAVAILABLE');
  const retryable = structured?.retryable ?? ['transport', 'timeout', 'device_offline'].includes(category);
  return Object.freeze({
    backend: 'commander',
    category,
    code,
    retryable: Boolean(retryable),
    deviceId: context.deviceId || '',
    operation: context.operation || '',
    newAttempt: false,
  });
}

export class CommanderV3Error extends Error {
  constructor(failure) {
    super(`commander:${failure.category}:${failure.code}`);
    this.name = 'CommanderV3Error';
    this.failure = failure;
  }
}

function throwFailure(error, context) {
  if (error instanceof CommanderV3Error) throw error;
  throw new CommanderV3Error(commanderFailure(error, context));
}

function operationFailure(result) {
  const error = validateCommanderError(result.error);
  return Object.freeze({
    backend: 'commander',
    category: error.code === 'REQUIRES_APPROVAL' ? 'approval' : error.category,
    code: error.code,
    retryable: Boolean(error.retryable),
    deviceId: result.deviceId,
    operation: result.operation,
    newAttempt: result.operation === 'execution.start',
  });
}

function executionFailure(execution, deviceId) {
  if (execution.state === 'requires_approval') {
    return Object.freeze({ backend: 'commander', category: 'approval', code: 'REQUIRES_APPROVAL', retryable: true, deviceId, operation: 'execution.start', newAttempt: true });
  }
  if (execution.state === 'device_offline') {
    return Object.freeze({ backend: 'commander', category: 'device_offline', code: 'DEVICE_OFFLINE', retryable: true, deviceId, operation: 'execution.get', newAttempt: false });
  }
  if (execution.error) {
    const error = validateCommanderError(execution.error);
    return Object.freeze({ backend: 'commander', category: error.category, code: error.code, retryable: Boolean(error.retryable), deviceId, operation: 'execution.get', newAttempt: true });
  }
  const category = execution.state === 'timeout' ? 'timeout' : execution.state === 'cancelled' ? 'cancelled' : 'execution';
  return Object.freeze({ backend: 'commander', category, code: `EXECUTION_${execution.state.toUpperCase()}`, retryable: category === 'timeout', deviceId, operation: 'execution.get', newAttempt: true });
}

export class CommanderV3Client {
  constructor({ client, now = Date.now, sleep = sleepMs, pollIntervalMs = 250, requestTimeoutMs = 5_000 } = {}) {
    if (!client || typeof client.request !== 'function') throw new Error('commander_public_client_required');
    this.client = client;
    this.now = now;
    this.sleep = sleep;
    this.pollIntervalMs = Math.max(25, Math.min(Number(pollIntervalMs), 2_000));
    this.requestTimeoutMs = Math.max(100, Math.min(Number(requestTimeoutMs), 30_000));
  }

  async execute(project, dispatch) {
    if (!project?.commander?.enabled) throw new Error('commander_project_not_enabled');
    if (dispatch.action === 'repo.inspect') return this.#inspect(project);
    if (dispatch.action === 'repo.test') return this.#test(project, dispatch);
    throw new Error(`unsupported_commander_action:${dispatch.action}`);
  }

  async #request(project, operation, params, options = {}) {
    const definition = operationDefinition(operation);
    const deviceId = project.commander.deviceId;
    const request = {
      ...protocolEnvelope(),
      requestId: requestId(operation),
      deviceId,
      operation,
      params,
      ...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
      ...(definition.requiresIdempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    };
    try {
      const result = validateOperationResult(await this.client.request(request, { timeoutMs: options.controlTimeoutMs ?? this.requestTimeoutMs }));
      if (!result.ok) throw new CommanderV3Error(operationFailure(result));
      return result;
    } catch (error) {
      throwFailure(error, { deviceId, operation });
    }
  }

  async #inspect(project) {
    const status = await this.#request(project, 'git.status', { repo: project.commander.repoPath });
    const log = await this.#request(project, 'git.log', { repo: project.commander.repoPath, limit: 1 });
    const head = log.data?.commits?.[0]?.sha;
    if (typeof head !== 'string' || !/^[0-9a-f]{40}$/i.test(head)) {
      throw new CommanderV3Error(Object.freeze({
        backend: 'commander', category: 'validation', code: 'COMMANDER_GIT_HEAD_MISSING', retryable: false,
        deviceId: project.commander.deviceId, operation: 'git.log', newAttempt: false,
      }));
    }
    const changes = Array.isArray(status.data?.changes) ? status.data.changes : [];
    const trackedChanges = changes.filter((line) => !String(line).startsWith('?? '));
    return JSON.stringify({
      backend: 'commander',
      deviceId: project.commander.deviceId,
      head,
      branch: normalizedBranch(status.data?.branch),
      cleanTracked: trackedChanges.length === 0,
      trackedStatus: boundedText(trackedChanges.join('\n'), 4000),
      changes: changes.slice(0, 256),
      truncated: Boolean(status.data?.truncated || log.data?.truncated),
      commander: {
        operations: ['git.status', 'git.log'],
        requestIds: [status.requestId, log.requestId],
        completedAt: [status.completedAt, log.completedAt],
      },
    });
  }

  async #test(project, dispatch) {
    const alias = String(dispatch.params?.alias ?? '');
    const commanderAlias = project.commander.testAliases?.[alias];
    if (!SAFE_ID.test(String(commanderAlias ?? ''))) throw new Error(`unknown_commander_test_alias:${alias}`);
    const timeoutMs = Number(project.tests?.[alias]?.timeoutMs ?? 600_000);
    const deadlineAt = new Date(this.now() + timeoutMs).toISOString();
    const start = await this.#request(project, 'execution.start', { alias: commanderAlias }, {
      deadlineAt,
      idempotencyKey: stableMutationKey(project, dispatch, `start:${commanderAlias}`),
    });
    let execution = start.data?.execution;
    if (!execution?.executionId) {
      throw new CommanderV3Error(Object.freeze({
        backend: 'commander', category: 'validation', code: 'COMMANDER_EXECUTION_ID_MISSING', retryable: false,
        deviceId: project.commander.deviceId, operation: 'execution.start', newAttempt: true,
      }));
    }
    const executionId = execution.executionId;
    const stopAt = this.now() + timeoutMs + 5_000;
    while (!TERMINAL.has(execution.state)) {
      if (this.now() >= stopAt) {
        await this.#cancelBestEffort(project, dispatch, executionId);
        throw new CommanderV3Error(Object.freeze({
          backend: 'commander', category: 'timeout', code: 'COMMANDER_EXECUTION_POLL_TIMEOUT', retryable: true,
          deviceId: project.commander.deviceId, operation: 'execution.get', newAttempt: false,
        }));
      }
      await this.sleep(this.pollIntervalMs);
      const current = await this.#request(project, 'execution.get', { executionId });
      execution = current.data?.execution;
      if (!execution?.state) {
        throw new CommanderV3Error(Object.freeze({
          backend: 'commander', category: 'validation', code: 'COMMANDER_EXECUTION_STATE_MISSING', retryable: false,
          deviceId: project.commander.deviceId, operation: 'execution.get', newAttempt: false,
        }));
      }
    }
    const outputResult = await this.#request(project, 'execution.output', { executionId, afterSequence: -1 });
    const events = Array.isArray(outputResult.data?.events) ? outputResult.data.events : [];
    const stdout = boundedText(events.filter((event) => event.type === 'stdout').map((event) => event.payload?.chunk ?? '').join(''));
    const stderr = boundedText(events.filter((event) => event.type === 'stderr').map((event) => event.payload?.chunk ?? '').join(''));
    if (execution.state !== 'success') throw new CommanderV3Error(executionFailure(execution, project.commander.deviceId));
    return JSON.stringify({
      backend: 'commander',
      deviceId: project.commander.deviceId,
      alias,
      commanderAlias,
      executionId,
      state: execution.state,
      exitCode: execution.exitCode ?? 0,
      stdout,
      stderr,
      truncated: Boolean(outputResult.data?.truncated),
      totalBytes: Number(outputResult.data?.totalBytes ?? 0),
      commander: {
        startRequestId: start.requestId,
        outputRequestId: outputResult.requestId,
        completedAt: execution.updatedAt || outputResult.completedAt,
      },
    });
  }

  async #cancelBestEffort(project, dispatch, executionId) {
    try {
      await this.#request(project, 'execution.cancel', { executionId }, {
        idempotencyKey: stableMutationKey(project, dispatch, `cancel:${executionId}`),
      });
    } catch { /* timeout path remains authoritative */ }
  }
}
