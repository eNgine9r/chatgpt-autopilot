import crypto from 'node:crypto';
import {
  commanderError,
  operationDefinition,
  protocolEnvelope,
  validateCommanderError,
  validateOperationResult,
} from '../../../commander/contracts/index.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TASK_BODY_BYTES = 32 * 1024;
const MAX_PARAMS_BYTES = 16 * 1024;
const MAX_COMMENT_BYTES = 48 * 1024;
const TERMINAL_EXEC_OPERATION = 'terminal.exec';
const TERMINAL_REQUIRED_OPERATIONS = Object.freeze([
  'execution.start', 'execution.input', 'execution.get', 'execution.output',
]);
const MAX_TERMINAL_COMMAND_BYTES = 8 * 1024;
const MAX_TERMINAL_STREAM_BYTES = 12 * 1024;
const TERMINAL_POLL_MS = 100;
const TERMINAL_STATES = new Set(['success', 'failed', 'cancelled', 'timeout', 'device_offline']);

export const DEFAULT_GITHUB_BRIDGE_OPERATIONS = Object.freeze([
  'device.health',
  'file.read', 'file.list', 'file.info', 'file.search',
  'process.list', 'service.status',
  'git.status', 'git.diff', 'git.log',
]);

function exactObject(value, required, optional = [], code = 'invalid_task') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${code}:missing:${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${code}:unknown:${key}`);
}
function plainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value;
}

function boundedJson(value, maxBytes, code) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new Error(code); }
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error(code);
  return value;
}

function taskRequestId(issueNumber, body) {
  const digest = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  return `github-${issueNumber}-${digest}`;
}

function capabilityEnabled(snapshot, operation) {
  return snapshot?.status === 'online'
    && snapshot?.device?.capabilities?.some((item) => item.operation === operation);
}

function bridgeOperationDefinition(operation) {
  if (operation === TERMINAL_EXEC_OPERATION) {
    return Object.freeze({ authority: 'write', requiresIdempotencyKey: true, bridgeWorkflow: true });
  }
  return operationDefinition(operation);
}

export function parseAllowedOperations(value) {
  if (!value) return new Set(DEFAULT_GITHUB_BRIDGE_OPERATIONS);
  const operations = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  if (!operations.length || operations.length > 64) throw new Error('invalid_github_bridge_operations');
  const out = new Set();
  for (const operation of operations) {
    const definition = bridgeOperationDefinition(operation);
    if (definition.authority === 'admin') throw new Error('github_bridge_admin_forbidden');
    out.add(operation);
  }
  return out;
}
export function parseCommanderGithubTask(issue, config) {
  if (!issue || !Number.isInteger(issue.number) || issue.number < 1) throw new Error('invalid_github_issue');
  if (issue.pull_request) throw new Error('github_bridge_pull_request_denied');
  if (issue.user?.login !== config.allowedAuthor || issue.author_association !== 'OWNER') {
    throw new Error('github_bridge_author_denied');
  }
  const body = String(issue.body || '');
  if (!body || Buffer.byteLength(body) > MAX_TASK_BODY_BYTES) throw new Error('invalid_github_task_body');
  let task;
  try { task = JSON.parse(body); } catch { throw new Error('invalid_github_task_json'); }
  exactObject(task, ['version', 'deviceId', 'operation', 'params'], ['timeoutMs', 'idempotencyKey'], 'invalid_github_task');
  if (task.version !== 1) throw new Error('unsupported_github_task_version');
  if (typeof task.deviceId !== 'string' || !ID.test(task.deviceId)) throw new Error('invalid_github_task_device');
  if (typeof task.operation !== 'string' || !config.allowedOperations.has(task.operation)) {
    throw new Error('github_bridge_operation_denied');
  }
  const definition = bridgeOperationDefinition(task.operation);
  if (definition.authority === 'admin') throw new Error('github_bridge_admin_forbidden');
  plainObject(task.params, 'invalid_github_task_params');
  if (task.operation === TERMINAL_EXEC_OPERATION) {
    exactObject(task.params, ['command'], [], 'invalid_github_terminal_params');
    if (typeof task.params.command !== 'string' || !task.params.command.trim() || task.params.command.includes('\0')) {
      throw new Error('invalid_github_terminal_command');
    }
    if (Buffer.byteLength(task.params.command) > MAX_TERMINAL_COMMAND_BYTES) throw new Error('github_terminal_command_too_large');
  }
  boundedJson(task.params, MAX_PARAMS_BYTES, 'github_task_params_too_large');
  const timeoutMs = task.timeoutMs === undefined ? 10_000 : Number(task.timeoutMs);
  const maxTimeoutMs = task.operation === TERMINAL_EXEC_OPERATION ? 120_000 : 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > maxTimeoutMs) throw new Error('invalid_github_task_timeout');
  if (definition.requiresIdempotencyKey && (typeof task.idempotencyKey !== 'string' || !ID.test(task.idempotencyKey))) {
    throw new Error('github_task_idempotency_required');
  }
  return Object.freeze({
    issueNumber: issue.number,
    body,
    deviceId: task.deviceId,
    operation: task.operation,
    params: task.params,
    timeoutMs,
    ...(definition.requiresIdempotencyKey ? { idempotencyKey: task.idempotencyKey } : {}),
  });
}

export function commanderRequestFromGithubTask(task) {
  if (task.operation === TERMINAL_EXEC_OPERATION) throw new Error('github_bridge_workflow_has_no_direct_request');
  const definition = operationDefinition(task.operation);
  return {
    ...protocolEnvelope(),
    requestId: taskRequestId(task.issueNumber, task.body),
    deviceId: task.deviceId,
    operation: task.operation,
    params: task.params,
    ...(definition.requiresIdempotencyKey ? { idempotencyKey: task.idempotencyKey } : {}),
    deadlineAt: new Date(Date.now() + task.timeoutMs).toISOString(),
  };
}

function workflowRequest(task, operation, params, deadlineMs, suffix, idempotencyKey) {
  return {
    ...protocolEnvelope(),
    requestId: `${taskRequestId(task.issueNumber, task.body)}:${suffix}`,
    deviceId: task.deviceId,
    operation,
    params,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    deadlineAt: new Date(deadlineMs).toISOString(),
  };
}

function workflowIdempotencyKey(task, suffix) {
  const digest = crypto.createHash('sha256').update(`${task.idempotencyKey}:${suffix}`).digest('hex').slice(0, 32);
  return `ghwf-${task.issueNumber}-${suffix}-${digest}`;
}

function remainingWorkflowMs(deadlineMs) {
  const remaining = deadlineMs - Date.now();
  if (remaining < 100) throw new Error('github_terminal_workflow_timeout');
  return remaining;
}

async function workflowCommanderRequest(client, request, deadlineMs) {
  const result = validateOperationResult(await client.request(request, { timeoutMs: Math.min(remainingWorkflowMs(deadlineMs), 10_000) }));
  if (!result.ok) {
    const error = new Error(result.error?.code || 'commander_workflow_operation_failed');
    error.commanderError = result.error;
    throw error;
  }
  return result;
}

function boundedUtf8(value, maxBytes) {
  const raw = Buffer.from(String(value || ''), 'utf8');
  if (raw.length <= maxBytes) return { text: raw.toString('utf8'), truncated: false };
  return { text: raw.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

async function executeTerminalWorkflow(task, client) {
  const deadlineMs = Date.now() + task.timeoutMs;
  const snapshot = await client.getDevice(task.deviceId, { timeoutMs: Math.min(task.timeoutMs, 10_000) });
  for (const operation of TERMINAL_REQUIRED_OPERATIONS) {
    if (!capabilityEnabled(snapshot, operation)) throw new Error('github_bridge_operation_not_advertised');
  }

  const start = await workflowCommanderRequest(client, workflowRequest(
    task, 'execution.start', { alias: 'operator.shell' }, deadlineMs, 'start', workflowIdempotencyKey(task, 'start'),
  ), deadlineMs);
  const executionId = start.data?.execution?.executionId;
  if (typeof executionId !== 'string' || !ID.test(executionId)) throw new Error('github_terminal_invalid_execution_id');

  const input = `${task.params.command}${task.params.command.endsWith('\n') ? '' : '\n'}exit\n`;
  await workflowCommanderRequest(client, workflowRequest(
    task, 'execution.input', { executionId, data: input }, deadlineMs, 'input', workflowIdempotencyKey(task, 'input'),
  ), deadlineMs);

  let execution;
  let poll = 0;
  do {
    const status = await workflowCommanderRequest(client, workflowRequest(
      task, 'execution.get', { executionId }, deadlineMs, `get-${poll}`,
    ), deadlineMs);
    execution = status.data?.execution;
    if (!execution || execution.executionId !== executionId || typeof execution.state !== 'string') {
      throw new Error('github_terminal_invalid_execution_state');
    }
    if (TERMINAL_STATES.has(execution.state)) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(TERMINAL_POLL_MS, remainingWorkflowMs(deadlineMs))));
    poll += 1;
  } while (true);

  const output = await workflowCommanderRequest(client, workflowRequest(
    task, 'execution.output', { executionId }, deadlineMs, 'output',
  ), deadlineMs);
  let stdout = '';
  let stderr = '';
  for (const event of output.data?.events || []) {
    if (event?.type === 'stdout' && typeof event.payload?.chunk === 'string') stdout += event.payload.chunk;
    if (event?.type === 'stderr' && typeof event.payload?.chunk === 'string') stderr += event.payload.chunk;
  }
  const safeStdout = boundedUtf8(stdout, MAX_TERMINAL_STREAM_BYTES);
  const safeStderr = boundedUtf8(stderr, MAX_TERMINAL_STREAM_BYTES);
  const totalBytes = Number(output.data?.totalBytes) || (Buffer.byteLength(stdout) + Buffer.byteLength(stderr));

  return {
    bridge: 'commander-github-v1',
    issueNumber: task.issueNumber,
    workflow: TERMINAL_EXEC_OPERATION,
    deviceId: task.deviceId,
    ok: execution.state === 'success',
    completedAt: new Date().toISOString(),
    data: {
      executionId,
      state: execution.state,
      ...(Number.isInteger(execution.exitCode) ? { exitCode: execution.exitCode } : {}),
      stdout: safeStdout.text,
      stderr: safeStderr.text,
      truncated: Boolean(output.data?.truncated || safeStdout.truncated || safeStderr.truncated),
      totalBytes,
    },
  };
}

export async function executeCommanderGithubTask({ issue, config, client }) {
  const task = parseCommanderGithubTask(issue, config);
  if (task.operation === TERMINAL_EXEC_OPERATION) return executeTerminalWorkflow(task, client);
  const snapshot = await client.getDevice(task.deviceId, { timeoutMs: Math.min(task.timeoutMs, 10_000) });
  if (!capabilityEnabled(snapshot, task.operation)) throw new Error('github_bridge_operation_not_advertised');
  const request = commanderRequestFromGithubTask(task);
  return validateOperationResult(await client.request(request, { timeoutMs: task.timeoutMs }));
}

function safeBridgeError(error) {
  if (error?.commanderError) {
    try { return validateCommanderError(error.commanderError); } catch { /* sanitize below */ }
  }
  const code = String(error?.code || error?.message || '');
  if (['control_request_timeout', 'control_connection_closed'].includes(code)) {
    return commanderError({ category: 'transport', code: 'GITHUB_BRIDGE_COMMANDER_UNAVAILABLE', message: 'Commander is temporarily unavailable', retryable: true });
  }
  const normalizedCode = code
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  const safeCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(normalizedCode)
    ? normalizedCode
    : 'GITHUB_BRIDGE_REJECTED';
  return commanderError({ category: 'validation', code: safeCode, message: 'GitHub Commander task was rejected', retryable: false });
}

export function githubBridgeFailure(issueNumber, error) {
  return {
    bridge: 'commander-github-v1',
    issueNumber,
    ok: false,
    completedAt: new Date().toISOString(),
    error: safeBridgeError(error),
  };
}

export function githubBridgeComment(payload) {
  const body = `<!-- commander-result:v1 -->\n${JSON.stringify(payload)}`;
  if (Buffer.byteLength(body) > MAX_COMMENT_BYTES) throw new Error('github_bridge_result_too_large');
  return body;
}
