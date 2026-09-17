import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  commanderError, operationDefinition, protocolEnvelope, validateOperationResult,
} from '../contracts/index.mjs';
import { runReadCommand } from './read-command.mjs';

export const WORK_SESSION_READ_OPERATIONS = Object.freeze(['work_session.list', 'work_session.get', 'work_session.resume']);
export const WORK_SESSION_WRITE_OPERATIONS = Object.freeze(['work_session.open', 'work_session.checkpoint', 'work_session.close']);
const ALL_OPERATIONS = new Set([...WORK_SESSION_READ_OPERATIONS, ...WORK_SESSION_WRITE_OPERATIONS]);
const TERMINAL_EXECUTION_STATES = new Set(['success', 'failed', 'cancelled', 'timeout', 'interrupted', 'unknown']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_RESUME_NOTE_BYTES = 4096;
const MAX_SESSIONS = 32;
const MAX_EXECUTIONS = 16;
const MAX_REPLAY = 128;

function nowIso(now) { return new Date(now()).toISOString(); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
function exact(value, label, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${label}`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`missing_${label}_${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown_${label}_${key}`);
}
function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`invalid_${label}`);
  return value;
}
function boundedText(value, label, maxBytes = MAX_RESUME_NOTE_BYTES) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes || value.includes('\0')) throw new Error(`invalid_${label}`);
  return value;
}
function fingerprint(operation, params) { return sha256(Buffer.from(JSON.stringify([operation, params]))); }
function safeEvidence(result) {
  const evidence = result?.data?.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return undefined;
  const encoded = JSON.stringify(evidence);
  if (Buffer.byteLength(encoded) > 4096) return { truncated: true, sha256: sha256(Buffer.from(encoded)) };
  return evidence;
}
function capability(operation) {
  const definition = operationDefinition(operation);
  return Object.freeze({ operation, authority: definition.authority, operationVersion: definition.operationVersion });
}
export function workSessionCapabilities({ writeEnabled = false } = {}) {
  return [...WORK_SESSION_READ_OPERATIONS, ...(writeEnabled ? WORK_SESSION_WRITE_OPERATIONS : [])].map(capability);
}

async function gitCommand(commandRunner, repo, args, maxOutputBytes = 64 * 1024) {
  const result = await commandRunner('git', args, { cwd: repo, timeoutMs: 10_000, maxOutputBytes });
  if (result.timedOut) throw new Error('WORK_SESSION_GIT_TIMEOUT');
  return result;
}

export class CommanderWorkSessionManager {
  constructor({ deviceId, stateFile, readPolicy, commandRunner = runReadCommand, now = Date.now, randomBytes = crypto.randomBytes, logger = console } = {}) {
    if (!deviceId || !ID.test(deviceId)) throw new Error('work_session_device_id_required');
    if (!path.isAbsolute(String(stateFile || ''))) throw new Error('work_session_state_file_must_be_absolute');
    if (!readPolicy) throw new Error('work_session_read_policy_required');
    this.deviceId = deviceId;
    this.stateFile = stateFile;
    this.readPolicy = readPolicy;
    this.commandRunner = commandRunner;
    this.now = now;
    this.randomBytes = randomBytes;
    this.logger = logger;
    this.state = { version: 1, deviceId, sessions: {}, replay: {} };
    this.loaded = false;
    this.persistQueue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    const parent = path.dirname(this.stateFile);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await fs.chmod(parent, 0o700);
    try {
      const stat = await fs.lstat(this.stateFile);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('invalid_work_session_state_file');
      if ((stat.mode & 0o077) !== 0) throw new Error('work_session_state_permissions_too_open');
      if (stat.size > MAX_STATE_BYTES) throw new Error('work_session_state_too_large');
      const parsed = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      if (!parsed || parsed.version !== 1 || parsed.deviceId !== this.deviceId || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) {
        throw new Error('invalid_work_session_state');
      }
      parsed.replay = parsed.replay && typeof parsed.replay === 'object' && !Array.isArray(parsed.replay) ? parsed.replay : {};
      this.state = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.#persist();
    }
    this.loaded = true;
    await this.markInterruptedExecutions('agent_restart');
    return this;
  }

  async handle(request) {
    await this.load();
    if (!ALL_OPERATIONS.has(request.operation)) throw new Error('work_session_operation_not_supported');
    if (request.deviceId !== this.deviceId) throw new Error('work_session_device_mismatch');
    const definition = operationDefinition(request.operation);
    if (definition.authority === 'write') return this.#idempotent(request, () => this.#mutate(request));
    if (request.operation === 'work_session.list') return this.#list(request);
    if (request.operation === 'work_session.get') return this.#get(request, false);
    if (request.operation === 'work_session.resume') return this.#get(request, true);
    throw new Error('work_session_operation_not_supported');
  }

  async guardMutation(request) {
    await this.load();
    if (!request.workSessionId || request.operation.startsWith('work_session.')) return null;
    const definition = operationDefinition(request.operation);
    if (definition.authority !== 'write') return null;
    if (request.operation.startsWith('execution.') && request.operation !== 'execution.start') return null;
    const session = this.#session(request.workSessionId);
    if (session.state !== 'open') return this.#failure(request, 'WORK_SESSION_CLOSED', 'conflict', false);
    const current = await this.#repositorySnapshot(session.repositoryPath);
    if (!this.#sameRepositorySnapshot(session.repository, current)) {
      return this.#failure(request, 'WORK_SESSION_DIVERGED', 'conflict', false, {
        sessionId: session.sessionId,
        stored: this.#publicRepositorySnapshot(session.repository),
        current: this.#publicRepositorySnapshot(current),
      });
    }
    return null;
  }

  async observeOperation(request, result) {
    await this.load();
    if (!request.workSessionId || request.operation.startsWith('work_session.')) return;
    const session = this.state.sessions[request.workSessionId];
    if (!session || session.state !== 'open') return;
    session.lastOperation = {
      operation: request.operation,
      requestId: request.requestId,
      ok: Boolean(result?.ok),
      completedAt: result?.completedAt || nowIso(this.now),
      ...(result?.error ? { error: { category: result.error.category, code: result.error.code } } : {}),
      ...(safeEvidence(result) ? { evidence: safeEvidence(result) } : {}),
    };
    if (request.operation === 'execution.start' && result?.ok) {
      const execution = result?.data?.execution;
      if (execution?.executionId) {
        session.executions = (session.executions || []).filter((item) => item.executionId !== execution.executionId);
        session.executions.push({ executionId: execution.executionId, state: execution.state, startedAt: execution.createdAt, updatedAt: execution.updatedAt });
        if (session.executions.length > MAX_EXECUTIONS) session.executions.splice(0, session.executions.length - MAX_EXECUTIONS);
      }
    }
    if (operationDefinition(request.operation).authority === 'write' && result?.ok) {
      session.repository = await this.#repositorySnapshot(session.repositoryPath);
    }
    session.updatedAt = nowIso(this.now);
    await this.#persist();
  }

  async observeExecutionEvent(event) {
    await this.load();
    let changed = false;
    for (const session of Object.values(this.state.sessions)) {
      const execution = (session.executions || []).find((item) => item.executionId === event.executionId);
      if (!execution) continue;
      execution.updatedAt = event.timestamp;
      if (event.type === 'state' && typeof event.payload?.state === 'string') execution.state = event.payload.state;
      if (event.type === 'result' && typeof event.payload?.state === 'string') execution.state = event.payload.state;
      if (event.type === 'result') {
        execution.totalBytes = Number(event.payload?.totalBytes || 0);
        execution.truncated = Boolean(event.payload?.truncated);
        session.repository = await this.#repositorySnapshot(session.repositoryPath).catch(() => session.repository);
      }
      session.updatedAt = nowIso(this.now);
      changed = true;
    }
    if (changed) await this.#persist();
  }

  async markInterruptedExecutions(reason = 'agent_restart') {
    let changed = false;
    for (const session of Object.values(this.state.sessions)) {
      for (const execution of session.executions || []) {
        if (TERMINAL_EXECUTION_STATES.has(execution.state)) continue;
        execution.state = 'interrupted';
        execution.interruptedReason = reason;
        execution.updatedAt = nowIso(this.now);
        changed = true;
      }
      if (changed) session.updatedAt = nowIso(this.now);
    }
    if (changed) await this.#persist();
  }

  async #mutate(request) {
    if (request.operation === 'work_session.open') return this.#open(request);
    if (request.operation === 'work_session.checkpoint') return this.#checkpoint(request);
    if (request.operation === 'work_session.close') return this.#close(request);
    throw new Error('work_session_mutation_not_supported');
  }

  async #idempotent(request, fn) {
    const key = request.idempotencyKey;
    const fp = fingerprint(request.operation, request.params);
    const prior = this.state.replay[key];
    if (prior) {
      if (prior.operation !== request.operation || prior.fingerprint !== fp) return this.#failure(request, 'IDEMPOTENCY_KEY_CONFLICT', 'conflict', false);
      return validateOperationResult({ ...prior.result, requestId: request.requestId, completedAt: nowIso(this.now) });
    }
    const result = await fn();
    this.state.replay[key] = { operation: request.operation, fingerprint: fp, result };
    const keys = Object.keys(this.state.replay);
    if (keys.length > MAX_REPLAY) for (const old of keys.slice(0, keys.length - MAX_REPLAY)) delete this.state.replay[old];
    await this.#persist();
    return result;
  }

  async #open(request) {
    exact(request.params, 'work_session_open_params', ['projectId', 'workspaceRoot', 'repositoryPath'], ['cwd', 'resumeNote']);
    const projectId = identifier(request.params.projectId, 'work_session_project_id');
    const workspaceRoot = await this.readPolicy.assertPath(request.params.workspaceRoot);
    const repositoryPath = await this.readPolicy.assertRepository(request.params.repositoryPath);
    if (!inside(workspaceRoot, repositoryPath) && !inside(repositoryPath, workspaceRoot)) throw new Error('WORK_SESSION_REPOSITORY_OUTSIDE_WORKSPACE');
    const cwd = await this.#validatedCwd(request.params.cwd || workspaceRoot, workspaceRoot);
    const resumeNote = boundedText(request.params.resumeNote || '', 'work_session_resume_note');
    const existing = Object.values(this.state.sessions).find((session) => session.state === 'open' && session.projectId === projectId && session.workspaceRoot === workspaceRoot);
    if (existing) return this.#success(request, { session: this.#publicSession(existing), reused: true });
    if (Object.keys(this.state.sessions).length >= MAX_SESSIONS) throw new Error('WORK_SESSION_LIMIT_REACHED');
    const sessionId = `work-${this.randomBytes(16).toString('hex')}`;
    const timestamp = nowIso(this.now);
    const repository = await this.#repositorySnapshot(repositoryPath);
    const session = {
      version: 1, sessionId, deviceId: this.deviceId, projectId, workspaceRoot, repositoryPath, cwd,
      state: 'open', createdAt: timestamp, updatedAt: timestamp, resumeNote,
      repository, executions: [], lastOperation: null,
    };
    this.state.sessions[sessionId] = session;
    return this.#success(request, { session: this.#publicSession(session), reused: false });
  }

  async #checkpoint(request) {
    exact(request.params, 'work_session_checkpoint_params', ['sessionId'], ['cwd', 'resumeNote']);
    const session = this.#session(request.params.sessionId);
    if (session.state !== 'open') return this.#failure(request, 'WORK_SESSION_CLOSED', 'conflict', false);
    if (request.params.cwd !== undefined) session.cwd = await this.#validatedCwd(request.params.cwd, session.workspaceRoot);
    if (request.params.resumeNote !== undefined) session.resumeNote = boundedText(request.params.resumeNote, 'work_session_resume_note');
    session.repository = await this.#repositorySnapshot(session.repositoryPath);
    session.updatedAt = nowIso(this.now);
    return this.#success(request, { session: this.#publicSession(session), checkpointed: true });
  }

  async #close(request) {
    exact(request.params, 'work_session_close_params', ['sessionId'], ['resumeNote']);
    const session = this.#session(request.params.sessionId);
    if (request.params.resumeNote !== undefined) session.resumeNote = boundedText(request.params.resumeNote, 'work_session_resume_note');
    session.repository = await this.#repositorySnapshot(session.repositoryPath).catch(() => session.repository);
    session.state = 'closed';
    session.closedAt = nowIso(this.now);
    session.updatedAt = session.closedAt;
    return this.#success(request, { session: this.#publicSession(session), closed: true });
  }

  #list(request) {
    exact(request.params, 'work_session_list_params', []);
    const sessions = Object.values(this.state.sessions)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((session) => this.#publicSession(session));
    return this.#success(request, { sessions });
  }

  async #get(request, refresh) {
    exact(request.params, refresh ? 'work_session_resume_params' : 'work_session_get_params', ['sessionId']);
    const session = this.#session(request.params.sessionId);
    let currentRepository = session.repository;
    let diverged = false;
    if (refresh) {
      currentRepository = await this.#repositorySnapshot(session.repositoryPath);
      diverged = !this.#sameRepositorySnapshot(session.repository, currentRepository);
    }
    return this.#success(request, {
      session: this.#publicSession(session),
      ...(refresh ? { diverged, currentRepository: this.#publicRepositorySnapshot(currentRepository) } : {}),
    });
  }

  async #repositorySnapshot(repositoryPath) {
    const head = await gitCommand(this.commandRunner, repositoryPath, ['rev-parse', 'HEAD']);
    if (head.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(head.stdout.trim())) throw new Error('WORK_SESSION_GIT_HEAD_FAILED');
    const branchResult = await gitCommand(this.commandRunner, repositoryPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : '';
    const status = await gitCommand(this.commandRunner, repositoryPath, ['status', '--porcelain=v1', '--untracked-files=normal']);
    if (status.exitCode !== 0) throw new Error('WORK_SESSION_GIT_STATUS_FAILED');
    if (status.truncated) throw new Error('WORK_SESSION_GIT_STATUS_TRUNCATED');
    const origin = await gitCommand(this.commandRunner, repositoryPath, ['remote', 'get-url', 'origin'], 4096);
    const originHash = origin.exitCode === 0 && !origin.truncated ? sha256(Buffer.from(origin.stdout.trim())) : null;
    const lines = status.stdout.split(/\r?\n/).filter(Boolean);
    return {
      head: head.stdout.trim(), branch, detached: branch === '', originHash,
      dirty: lines.length > 0, statusHash: sha256(Buffer.from(status.stdout)),
      statusCount: lines.length, statusSummary: lines.slice(0, 20).map((line) => line.slice(0, 512)),
      capturedAt: nowIso(this.now),
    };
  }

  #sameRepositorySnapshot(a, b) {
    return a?.head === b?.head && a?.branch === b?.branch && a?.statusHash === b?.statusHash && a?.originHash === b?.originHash;
  }

  async #validatedCwd(candidate, workspaceRoot) {
    const resolved = await this.readPolicy.assertPath(candidate);
    if (!inside(workspaceRoot, resolved)) throw new Error('WORK_SESSION_CWD_OUTSIDE_WORKSPACE');
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error('WORK_SESSION_CWD_NOT_DIRECTORY');
    return resolved;
  }

  #session(sessionId) {
    identifier(sessionId, 'work_session_id');
    const session = this.state.sessions[sessionId];
    if (!session) throw new Error('WORK_SESSION_NOT_FOUND');
    return session;
  }

  #publicRepositorySnapshot(repository) {
    return {
      head: repository.head, branch: repository.branch, detached: repository.detached,
      dirty: repository.dirty, statusCount: repository.statusCount,
      statusSummary: repository.statusSummary, capturedAt: repository.capturedAt,
    };
  }

  #publicSession(session) {
    return {
      version: session.version, sessionId: session.sessionId, deviceId: session.deviceId,
      projectId: session.projectId, workspaceRoot: session.workspaceRoot, repositoryPath: session.repositoryPath,
      cwd: session.cwd, state: session.state, createdAt: session.createdAt, updatedAt: session.updatedAt,
      ...(session.closedAt ? { closedAt: session.closedAt } : {}),
      resumeNote: session.resumeNote,
      repository: this.#publicRepositorySnapshot(session.repository),
      executions: (session.executions || []).map((item) => ({ ...item })),
      lastOperation: session.lastOperation ? { ...session.lastOperation } : null,
    };
  }

  #success(request, data) {
    return validateOperationResult({
      ...protocolEnvelope(), requestId: request.requestId, deviceId: request.deviceId,
      operation: request.operation, ok: true, completedAt: nowIso(this.now), data,
    });
  }

  #failure(request, code, category = 'execution', retryable = false, details) {
    return validateOperationResult({
      ...protocolEnvelope(), requestId: request.requestId, deviceId: request.deviceId,
      operation: request.operation, ok: false, completedAt: nowIso(this.now),
      ...(details ? { data: details } : {}),
      error: commanderError({ category, code, message: 'Commander work session operation failed safely.', retryable }),
    });
  }

  #persist() {
    const task = this.persistQueue.then(() => this.#persistNow());
    this.persistQueue = task.catch(() => {});
    return task;
  }

  async #persistNow() {
    const parent = path.dirname(this.stateFile);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await fs.chmod(parent, 0o700);
    const encoded = `${JSON.stringify(this.state)}\n`;
    if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new Error('work_session_state_too_large');
    const temp = `${this.stateFile}.${process.pid}.${this.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp, encoded, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, this.stateFile);
      await fs.chmod(this.stateFile, 0o600);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }
}
