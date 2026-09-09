import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMANDER_OPERATIONS,
  COMMANDER_PROTOCOL,
  commanderError,
  negotiateCommanderProtocol,
  operationDefinition,
  protocolEnvelope,
  validateCapability,
  validateCommanderError,
  validateDevice,
  validateExecution,
  validateExecutionEvent,
  validateOperationRequest,
  validateOperationResult,
} from '../src/commander/contracts/index.mjs';

const envelope = protocolEnvelope();
const now = '2026-09-09T10:00:00Z';

function capability(operation) {
  const definition = COMMANDER_OPERATIONS[operation];
  return { operation, authority: definition.authority, operationVersion: definition.operationVersion };
}

function error(overrides = {}) {
  return commanderError({
    category: 'execution',
    code: 'COMMAND_FAILED',
    message: 'bounded failure',
    retryable: false,
    ...overrides,
  });
}

function request(operation = 'device.health', overrides = {}) {
  return {
    ...envelope,
    requestId: 'req-1',
    deviceId: 'btc-radar',
    operation,
    params: {},
    ...(COMMANDER_OPERATIONS[operation]?.requiresIdempotencyKey ? { idempotencyKey: 'idem-1' } : {}),
    ...overrides,
  };
}

function execution(overrides = {}) {
  return {
    ...envelope,
    executionId: 'exec-1',
    requestId: 'req-1',
    deviceId: 'btc-radar',
    operation: 'execution.start',
    state: 'running',
    createdAt: now,
    updatedAt: now,
    idempotencyKey: 'idem-1',
    limits: { timeoutMs: 10_000, maxOutputBytes: 4096 },
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    ...envelope,
    requestId: 'req-1',
    deviceId: 'btc-radar',
    operation: 'device.health',
    ok: true,
    completedAt: now,
    data: { healthy: true },
    ...overrides,
  };
}

test('protocol v1 negotiates only an overlapping Commander range', () => {
  assert.deepEqual(envelope, { protocol: 'commander', protocolVersion: 1, minProtocolVersion: 1 });
  assert.equal(negotiateCommanderProtocol(envelope), 1);
  assert.equal(negotiateCommanderProtocol({ protocol: 'commander', protocolVersion: 2, minProtocolVersion: 1 }), 1);
  assert.throws(() => negotiateCommanderProtocol({ protocol: 'other', protocolVersion: 1, minProtocolVersion: 1 }), /unsupported_protocol/);
  assert.throws(() => negotiateCommanderProtocol({ protocol: 'commander', protocolVersion: 2, minProtocolVersion: 2 }), /incompatible_protocol_version/);
});

test('operation registry has stable explicit authority and no generic shell operation', () => {
  assert.equal(operationDefinition('file.read').authority, 'read');
  assert.equal(operationDefinition('file.write').authority, 'write');
  assert.equal(operationDefinition('system.reboot').authority, 'admin');
  assert.equal(COMMANDER_OPERATIONS['execution.start'].requiresIdempotencyKey, true);
  assert.equal(COMMANDER_OPERATIONS['device.health'].requiresIdempotencyKey, false);
  assert.equal(COMMANDER_OPERATIONS['shell.exec'], undefined);
  assert.throws(() => operationDefinition('shell.exec'), /unsupported_operation/);
});

test('device contract validates Linux identity and capability advertisement', () => {
  const device = {
    ...envelope,
    deviceId: 'nexolab-edge-01',
    displayName: 'NexoLab edge',
    platform: 'linux',
    agentVersion: '0.1.0',
    sessionId: 'session-1',
    connectedAt: now,
    capabilities: [capability('device.health'), capability('file.read')],
  };
  assert.equal(validateDevice(device), device);
  assert.throws(() => validateDevice({ ...device, platform: 'windows' }), /unsupported_platform/);
  assert.throws(() => validateDevice({ ...device, capabilities: [capability('file.read'), capability('file.read')] }), /duplicate_capability/);
  assert.throws(() => validateDevice({ ...device, capabilities: [{ ...capability('file.read'), authority: 'write' }] }), /capability_authority_mismatch/);
  assert.throws(() => validateDevice({ ...device, secret: 'nope' }), /unknown_field/);
});

test('capability operation versions fail closed', () => {
  assert.deepEqual(validateCapability(capability('git.status')), capability('git.status'));
  assert.throws(() => validateCapability({ ...capability('git.status'), operationVersion: 2 }), /unsupported_operation_version/);
  assert.throws(() => validateCapability({ operation: 'unknown', authority: 'read', operationVersion: 1 }), /unsupported_operation/);
});

test('read requests need no idempotency key but mutating requests require one', () => {
  assert.equal(validateOperationRequest(request('file.read')).operation, 'file.read');
  assert.equal(validateOperationRequest(request('file.write')).idempotencyKey, 'idem-1');
  const missing = request('file.write');
  delete missing.idempotencyKey;
  assert.throws(() => validateOperationRequest(missing), /missing_idempotency_key/);
  assert.throws(() => validateOperationRequest(request('device.health', { operation: 'shell.exec' })), /unsupported_operation/);
});

test('request payloads and fields are bounded and strict', () => {
  assert.throws(() => validateOperationRequest(request('file.read', { params: { data: 'x'.repeat(300_000) } })), /payload_too_large/);
  assert.throws(() => validateOperationRequest(request('file.read', { injected: true })), /unknown_field/);
  assert.throws(() => validateOperationRequest(request('file.read', { deadlineAt: 'tomorrow' })), /invalid_timestamp/);
});

test('execution contract enforces states, bounds and failure evidence', () => {
  assert.equal(validateExecution(execution()).state, 'running');
  assert.equal(validateExecution(execution({ state: 'requires_approval' })).state, 'requires_approval');
  assert.throws(() => validateExecution(execution({ state: 'mystery' })), /unsupported_value/);
  assert.throws(() => validateExecution(execution({ state: 'failed' })), /missing_error/);
  assert.equal(validateExecution(execution({ state: 'failed', error: error() })).error.code, 'COMMAND_FAILED');
  assert.throws(() => validateExecution(execution({ limits: { timeoutMs: 99, maxOutputBytes: 4096 } })), /invalid_integer/);
});

test('CommanderError is versioned, categorized and bounded', () => {
  const value = error({ category: 'policy', code: 'DENIED_PATH', retryable: false, details: { path: '/root' } });
  assert.equal(validateCommanderError(value), value);
  assert.throws(() => validateCommanderError({ ...value, category: 'random' }), /unsupported_value/);
  assert.throws(() => validateCommanderError({ ...value, code: 'bad-code' }), /invalid_string/);
  assert.throws(() => validateCommanderError({ ...value, details: { blob: 'x'.repeat(20_000) } }), /payload_too_large/);
});

test('operation result requires error on failure and rejects error on success', () => {
  assert.equal(validateOperationResult(result()).ok, true);
  const failed = result({ ok: false, data: undefined, error: error({ category: 'timeout', code: 'EXECUTION_TIMEOUT', retryable: true }) });
  assert.equal(validateOperationResult(failed).error.retryable, true);
  assert.throws(() => validateOperationResult(result({ ok: false })), /missing_error/);
  assert.throws(() => validateOperationResult(result({ error: error() })), /unexpected_error/);
});

test('operation output has explicit truncation metadata and hard byte bound', () => {
  const value = result({
    executionId: 'exec-1',
    output: { stdout: 'ok', stderr: '', truncated: false, totalBytes: 2 },
  });
  assert.equal(validateOperationResult(value).output.totalBytes, 2);
  assert.throws(() => validateOperationResult(result({
    output: { stdout: 'x'.repeat(65_000), stderr: 'y'.repeat(1_000), truncated: true, totalBytes: 66_000 },
  })), /output_too_large/);
});

test('execution events are ordered, typed and bounded', () => {
  const stateEvent = {
    ...envelope,
    eventId: 'evt-1', executionId: 'exec-1', requestId: 'req-1', deviceId: 'btc-radar',
    type: 'state', sequence: 1, timestamp: now, payload: { state: 'running' },
  };
  assert.equal(validateExecutionEvent(stateEvent).sequence, 1);
  assert.equal(validateExecutionEvent({ ...stateEvent, type: 'stdout', payload: { chunk: 'hello' } }).payload.chunk, 'hello');
  assert.throws(() => validateExecutionEvent({ ...stateEvent, sequence: -1 }), /invalid_integer/);
  assert.throws(() => validateExecutionEvent({ ...stateEvent, payload: { state: 'unknown' } }), /unsupported_value/);
  assert.throws(() => validateExecutionEvent({ ...stateEvent, type: 'stderr', payload: { chunk: 'x'.repeat(70_000) } }), /payload_too_large/);
});

test('normal v1 messages reject incompatible or future protocol versions', () => {
  assert.equal(COMMANDER_PROTOCOL.currentVersion, 1);
  assert.throws(() => validateOperationRequest(request('device.health', { protocolVersion: 2 })), /unsupported_protocol_version/);
  assert.throws(() => validateOperationResult(result({ minProtocolVersion: 2 })), /invalid_version_range|incompatible_protocol_version/);
});
