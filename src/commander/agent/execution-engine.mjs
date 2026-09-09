import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import {
  commanderError, operationDefinition, protocolEnvelope, validateExecution, validateExecutionEvent, validateOperationResult,
} from '../contracts/index.mjs';

const TERMINAL = new Set(['success', 'failed', 'cancelled', 'timeout']);
const MAX_INPUT_BYTES = 8 * 1024;
const MAX_REPLAY = 1024;
const MAX_EVENTS = 256;

function exactParams(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_execution_params');
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`missing_execution_param:${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown_execution_param:${key}`);
}

function id(value, code = 'invalid_execution_id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(code);
  return value;
}

function safeEnvironment() {
  return Object.freeze({ PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
}

function nowIso(now) { return new Date(now()).toISOString(); }

export class CommanderExecutionEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.deviceId) throw new Error('execution_device_id_required');
    if (!options.policy?.commands) throw new Error('execution_policy_required');
    this.deviceId = options.deviceId;
    this.policy = options.policy;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? crypto.randomBytes;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.maxOutputBytes = Math.min(Number(options.maxOutputBytes ?? 64 * 1024), 64 * 1024);
    this.killGraceMs = Math.max(50, Math.min(Number(options.killGraceMs ?? 500), 5_000));
    this.executions = new Map();
    this.replay = new Map();
  }

  async handle(request) {
    const definition = operationDefinition(request.operation);
    if (!request.operation.startsWith('execution.')) throw new Error('unsupported_execution_operation');
    if (definition.authority === 'write') return this.#idempotent(request, () => this.#mutate(request));
    if (request.operation === 'execution.get') return this.#get(request);
    if (request.operation === 'execution.output') return this.#output(request);
    throw new Error('unsupported_execution_operation');
  }

  #idempotent(request, fn) {
    const key = request.idempotencyKey;
    const fingerprint = JSON.stringify(request.params);
    const prior = this.replay.get(key);
    if (prior) {
      if (prior.operation !== request.operation || prior.deviceId !== request.deviceId || prior.fingerprint !== fingerprint) throw new Error('idempotency_key_conflict');
      return validateOperationResult({ ...prior.result, requestId: request.requestId, completedAt: nowIso(this.now) });
    }
    const result = fn();
    const remember = (resolved) => {
      this.replay.set(key, { operation: request.operation, deviceId: request.deviceId, fingerprint, result: resolved });
      while (this.replay.size > MAX_REPLAY) this.replay.delete(this.replay.keys().next().value);
      return resolved;
    };
    return result && typeof result.then === 'function' ? result.then(remember) : remember(result);
  }

  #mutate(request) {
    if (request.operation === 'execution.start') return this.#start(request);
    if (request.operation === 'execution.input') return this.#input(request);
    if (request.operation === 'execution.cancel') return this.#cancel(request);
    throw new Error('unsupported_execution_mutation');
  }

  #result(request, { ok = true, data, error } = {}) {
    return validateOperationResult({
      ...protocolEnvelope(), requestId: request.requestId, deviceId: request.deviceId, operation: request.operation,
      ok, completedAt: nowIso(this.now), ...(data === undefined ? {} : { data }), ...(error ? { error } : {}),
    });
  }

  #activeCount() {
    let count = 0;
    for (const record of this.executions.values()) if (!TERMINAL.has(record.execution.state)) count += 1;
    return count;
  }

  #start(request) {
    exactParams(request.params, ['alias']);
    const alias = id(request.params.alias, 'invalid_execution_alias');
    const command = this.policy.commands.get(alias);
    if (!command) return this.#result(request, { ok: false, error: commanderError({ category: 'policy', code: 'EXECUTION_ALIAS_DENIED', message: 'Execution alias is not allowlisted.', retryable: false }) });
    if (this.#activeCount() >= this.policy.maxConcurrent) return this.#result(request, { ok: false, error: commanderError({ category: 'conflict', code: 'EXECUTION_CONCURRENCY_LIMIT', message: 'Execution concurrency limit reached.', retryable: true }) });
    const executionId = `exec-${this.randomBytes(16).toString('hex')}`;
    const createdAt = nowIso(this.now);
    const timeoutMs = Math.min(command.timeoutMs, request.deadlineAt ? Math.max(100, Date.parse(request.deadlineAt) - this.now()) : command.timeoutMs);
    const execution = validateExecution({
      ...protocolEnvelope(), executionId, requestId: request.requestId, deviceId: request.deviceId, operation: request.operation,
      state: 'queued', createdAt, updatedAt: createdAt, idempotencyKey: request.idempotencyKey,
      limits: { timeoutMs, maxOutputBytes: this.maxOutputBytes },
    });
    const record = { execution, command, child: null, events: [], sequence: 0, outputBytes: 0, totalBytes: 0, truncated: false, terminalIntent: null, timer: null, killTimer: null, waiters: [] };
    this.executions.set(executionId, record);
    this.#event(record, 'state', { state: 'queued' });
    this.#spawn(record);
    return this.#result(request, { data: { execution: record.execution } });
  }

  #spawn(record) {
    const { command } = record;
    let child;
    try {
      child = this.spawnImpl(command.executable, command.args, {
        cwd: command.cwd, env: safeEnvironment(), shell: false, detached: true,
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (error) {
      this.#finish(record, 'failed', null, commanderError({ category: 'execution', code: 'EXECUTION_SPAWN_FAILED', message: 'Failed to start allowlisted execution.', retryable: false }));
      return;
    }
    record.child = child;
    this.#transition(record, 'running');
    child.stdout?.on('data', (chunk) => this.#outputChunk(record, 'stdout', chunk));
    child.stderr?.on('data', (chunk) => this.#outputChunk(record, 'stderr', chunk));
    child.on('error', () => {
      if (!TERMINAL.has(record.execution.state)) this.#finish(record, 'failed', null, commanderError({ category: 'execution', code: 'EXECUTION_PROCESS_ERROR', message: 'Allowlisted execution process failed.', retryable: false }));
    });
    child.on('exit', (code) => {
      if (TERMINAL.has(record.execution.state)) return this.#resolveWaiters(record);
      const intended = record.terminalIntent;
      if (intended === 'cancelled' || intended === 'timeout') return this.#finish(record, intended, null);
      if (code === 0) this.#finish(record, 'success', 0);
      else this.#finish(record, 'failed', Number.isInteger(code) && code >= 0 && code <= 255 ? code : undefined,
        commanderError({ category: 'execution', code: 'EXECUTION_EXIT_NONZERO', message: 'Allowlisted execution exited unsuccessfully.', retryable: false }));
    });
    record.timer = setTimeout(() => this.#terminate(record, 'timeout'), record.execution.limits.timeoutMs);
    record.timer.unref?.();
  }

  #transition(record, state) {
    record.execution = validateExecution({ ...record.execution, state, updatedAt: nowIso(this.now) });
    this.#event(record, 'state', { state });
  }

  #finish(record, state, exitCode, error) {
    clearTimeout(record.timer); clearTimeout(record.killTimer);
    record.timer = null; record.killTimer = null;
    const next = { ...record.execution, state, updatedAt: nowIso(this.now) };
    if (Number.isInteger(exitCode)) next.exitCode = exitCode; else delete next.exitCode;
    if (error) next.error = error; else delete next.error;
    record.execution = validateExecution(next);
    this.#event(record, 'state', { state });
    this.#event(record, 'result', { state, ...(Number.isInteger(exitCode) ? { exitCode } : {}), truncated: record.truncated, totalBytes: record.totalBytes });
    this.#resolveWaiters(record);
  }

  #event(record, type, payload) {
    const event = validateExecutionEvent({
      ...protocolEnvelope(), eventId: `event-${record.execution.executionId}-${record.sequence}`,
      executionId: record.execution.executionId, requestId: record.execution.requestId, deviceId: this.deviceId,
      type, sequence: record.sequence++, timestamp: nowIso(this.now), payload,
    });
    record.events.push(event);
    if (record.events.length > MAX_EVENTS) { record.events.shift(); record.truncated = true; }
    this.emit('event', event);
    return event;
  }

  #outputChunk(record, type, chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    record.totalBytes += buffer.length;
    const remaining = Math.max(0, this.maxOutputBytes - record.outputBytes);
    if (remaining <= 0) { record.truncated = true; return; }
    const kept = buffer.subarray(0, remaining);
    record.outputBytes += kept.length;
    if (kept.length < buffer.length) record.truncated = true;
    if (kept.length) this.#event(record, type, { chunk: kept.toString('utf8') });
  }

  #get(request) {
    exactParams(request.params, ['executionId']);
    const record = this.#record(request.params.executionId);
    return this.#result(request, { data: { execution: record.execution } });
  }

  #output(request) {
    exactParams(request.params, ['executionId'], ['afterSequence']);
    const record = this.#record(request.params.executionId);
    const after = request.params.afterSequence === undefined ? -1 : Number(request.params.afterSequence);
    if (!Number.isSafeInteger(after) || after < -1) throw new Error('invalid_execution_output_sequence');
    return this.#result(request, { data: { events: record.events.filter((event) => event.sequence > after), truncated: record.truncated, totalBytes: record.totalBytes, nextSequence: record.sequence } });
  }

  #input(request) {
    exactParams(request.params, ['executionId', 'data']);
    const record = this.#record(request.params.executionId);
    if (record.execution.state !== 'running' || !record.child?.stdin || record.child.stdin.destroyed) return this.#result(request, { ok: false, error: commanderError({ category: 'conflict', code: 'EXECUTION_NOT_RUNNING', message: 'Execution is not accepting input.', retryable: false }) });
    if (!record.command.allowStdin) return this.#result(request, { ok: false, error: commanderError({ category: 'policy', code: 'EXECUTION_STDIN_DENIED', message: 'Input is disabled for this execution alias.', retryable: false }) });
    if (typeof request.params.data !== 'string' || Buffer.byteLength(request.params.data) > MAX_INPUT_BYTES) throw new Error('invalid_execution_input');
    record.child.stdin.write(request.params.data);
    return this.#result(request, { data: { executionId: record.execution.executionId, acceptedBytes: Buffer.byteLength(request.params.data) } });
  }

  #cancel(request) {
    exactParams(request.params, ['executionId']);
    const record = this.#record(request.params.executionId);
    if (TERMINAL.has(record.execution.state)) return this.#result(request, { data: { execution: record.execution } });
    this.#terminate(record, 'cancelled');
    return this.#result(request, { data: { execution: record.execution } });
  }

  #terminate(record, state) {
    if (TERMINAL.has(record.execution.state)) return;
    record.terminalIntent = state;
    const child = record.child;
    if (!child || !child.pid) return this.#finish(record, state, null);
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    record.killTimer = setTimeout(() => {
      if (TERMINAL.has(record.execution.state)) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      this.#finish(record, state, null);
    }, this.killGraceMs);
    record.killTimer.unref?.();
  }

  #record(executionId) {
    id(executionId);
    const record = this.executions.get(executionId);
    if (!record) throw new Error('execution_not_found');
    return record;
  }

  waitForTerminal(executionId, timeoutMs = 5_000) {
    const record = this.#record(executionId);
    if (TERMINAL.has(record.execution.state)) return Promise.resolve(record.execution);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('execution_wait_timeout')), timeoutMs);
      record.waiters.push((execution) => { clearTimeout(timer); resolve(execution); });
    });
  }

  #resolveWaiters(record) {
    const waiters = record.waiters.splice(0);
    for (const resolve of waiters) resolve(record.execution);
  }

  async shutdown() {
    const waits = [];
    for (const record of this.executions.values()) {
      if (!TERMINAL.has(record.execution.state)) {
        this.#terminate(record, 'cancelled');
        waits.push(this.waitForTerminal(record.execution.executionId).catch(() => null));
      }
    }
    await Promise.all(waits);
  }
}
