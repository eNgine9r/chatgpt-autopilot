import {
  COMMANDER_AUTHORITIES,
  COMMANDER_ERROR_CATEGORIES,
  COMMANDER_EVENT_TYPES,
  COMMANDER_EXECUTION_STATES,
  COMMANDER_LIMITS,
  COMMANDER_OPERATIONS,
  COMMANDER_PROTOCOL,
} from './constants.mjs';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export class CommanderContractViolation extends Error {
  constructor(code, path, detail = '') {
    super(`${code}:${path}${detail ? `:${detail}` : ''}`);
    this.name = 'CommanderContractViolation';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, detail = '') {
  throw new CommanderContractViolation(code, path, detail);
}

function plainObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_object', path);
  return value;
}

function exactKeys(value, path, required, optional = []) {
  plainObject(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) fail('missing_field', `${path}.${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('unknown_field', `${path}.${key}`);
}

function stringValue(value, path, { min = 1, max = 512, pattern } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail('invalid_string', path);
  if (pattern && !pattern.test(value)) fail('invalid_string', path);
  return value;
}

function identifier(value, path) {
  return stringValue(value, path, { max: COMMANDER_LIMITS.maxIdentifierLength, pattern: IDENTIFIER });
}

function integer(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_integer', path);
  return value;
}

function booleanValue(value, path) {
  if (typeof value !== 'boolean') fail('invalid_boolean', path);
  return value;
}

function timestamp(value, path) {
  stringValue(value, path, { max: 40 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    fail('invalid_timestamp', path);
  }
  return value;
}

function boundedJson(value, path, maxBytes = COMMANDER_LIMITS.maxDetailsBytes) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail('invalid_json', path); }
  if (encoded === undefined || Buffer.byteLength(encoded) > maxBytes) fail('payload_too_large', path);
  return value;
}

function oneOf(value, allowed, path) {
  if (!allowed.includes(value)) fail('unsupported_value', path, String(value));
  return value;
}

function protocolFields(value, path) {
  if (value.protocol !== COMMANDER_PROTOCOL.name) fail('unsupported_protocol', `${path}.protocol`);
  integer(value.protocolVersion, `${path}.protocolVersion`, { min: 1, max: 65535 });
  integer(value.minProtocolVersion, `${path}.minProtocolVersion`, { min: 1, max: 65535 });
  if (value.minProtocolVersion > value.protocolVersion) fail('invalid_version_range', path);
  if (value.protocolVersion !== COMMANDER_PROTOCOL.currentVersion) fail('unsupported_protocol_version', `${path}.protocolVersion`);
  if (value.minProtocolVersion > COMMANDER_PROTOCOL.currentVersion) fail('incompatible_protocol_version', `${path}.minProtocolVersion`);
}

const commonRequired = ['protocol', 'protocolVersion', 'minProtocolVersion'];

export function protocolEnvelope() {
  return {
    protocol: COMMANDER_PROTOCOL.name,
    protocolVersion: COMMANDER_PROTOCOL.currentVersion,
    minProtocolVersion: COMMANDER_PROTOCOL.minCompatibleVersion,
  };
}

export function negotiateCommanderProtocol(peer) {
  exactKeys(peer, 'peer', commonRequired);
  if (peer.protocol !== COMMANDER_PROTOCOL.name) fail('unsupported_protocol', 'peer.protocol');
  integer(peer.protocolVersion, 'peer.protocolVersion', { min: 1, max: 65535 });
  integer(peer.minProtocolVersion, 'peer.minProtocolVersion', { min: 1, max: 65535 });
  if (peer.minProtocolVersion > peer.protocolVersion) fail('invalid_version_range', 'peer');
  const upper = Math.min(COMMANDER_PROTOCOL.currentVersion, peer.protocolVersion);
  const lower = Math.max(COMMANDER_PROTOCOL.minCompatibleVersion, peer.minProtocolVersion);
  if (lower > upper) fail('incompatible_protocol_version', 'peer');
  return upper;
}

export function operationDefinition(operation) {
  stringValue(operation, 'operation', { max: 96 });
  const definition = COMMANDER_OPERATIONS[operation];
  if (!definition) fail('unsupported_operation', 'operation', operation);
  return definition;
}

export function validateCapability(value, path = 'capability') {
  exactKeys(value, path, ['operation', 'authority', 'operationVersion']);
  const definition = operationDefinition(value.operation);
  oneOf(value.authority, COMMANDER_AUTHORITIES, `${path}.authority`);
  integer(value.operationVersion, `${path}.operationVersion`, { min: 1, max: 65535 });
  if (value.authority !== definition.authority) fail('capability_authority_mismatch', `${path}.authority`);
  if (value.operationVersion !== definition.operationVersion) fail('unsupported_operation_version', `${path}.operationVersion`);
  return value;
}

export function validateDevice(value) {
  const path = 'device';
  exactKeys(value, path,
    [...commonRequired, 'deviceId', 'platform', 'agentVersion', 'capabilities'],
    ['displayName', 'sessionId', 'connectedAt']);
  protocolFields(value, path);
  identifier(value.deviceId, `${path}.deviceId`);
  if (value.platform !== 'linux') fail('unsupported_platform', `${path}.platform`);
  stringValue(value.agentVersion, `${path}.agentVersion`, { max: 64, pattern: SEMVER });
  if (value.displayName !== undefined) stringValue(value.displayName, `${path}.displayName`, { max: 120 });
  if (value.sessionId !== undefined) identifier(value.sessionId, `${path}.sessionId`);
  if (value.connectedAt !== undefined) timestamp(value.connectedAt, `${path}.connectedAt`);
  if (!Array.isArray(value.capabilities) || value.capabilities.length > COMMANDER_LIMITS.maxCapabilities) {
    fail('invalid_capabilities', `${path}.capabilities`);
  }
  const seen = new Set();
  value.capabilities.forEach((capability, index) => {
    validateCapability(capability, `${path}.capabilities[${index}]`);
    if (seen.has(capability.operation)) fail('duplicate_capability', `${path}.capabilities[${index}].operation`);
    seen.add(capability.operation);
  });
  return value;
}

export function validateOperationRequest(value) {
  const path = 'request';
  exactKeys(value, path,
    [...commonRequired, 'requestId', 'deviceId', 'operation', 'params'],
    ['idempotencyKey', 'deadlineAt']);
  protocolFields(value, path);
  identifier(value.requestId, `${path}.requestId`);
  identifier(value.deviceId, `${path}.deviceId`);
  const definition = operationDefinition(value.operation);
  boundedJson(value.params, `${path}.params`, COMMANDER_LIMITS.maxMessageBytes);
  if (value.deadlineAt !== undefined) timestamp(value.deadlineAt, `${path}.deadlineAt`);
  if (definition.requiresIdempotencyKey && value.idempotencyKey === undefined) {
    fail('missing_idempotency_key', `${path}.idempotencyKey`);
  }
  if (value.idempotencyKey !== undefined) identifier(value.idempotencyKey, `${path}.idempotencyKey`);
  return value;
}

function validateLimits(value, path) {
  exactKeys(value, path, ['timeoutMs', 'maxOutputBytes']);
  integer(value.timeoutMs, `${path}.timeoutMs`, { min: 100, max: COMMANDER_LIMITS.maxTimeoutMs });
  integer(value.maxOutputBytes, `${path}.maxOutputBytes`, { min: 1024, max: COMMANDER_LIMITS.maxOutputBytes });
}

export function validateCommanderError(value, path = 'error') {
  exactKeys(value, path,
    [...commonRequired, 'category', 'code', 'message', 'retryable'],
    ['details']);
  protocolFields(value, path);
  oneOf(value.category, COMMANDER_ERROR_CATEGORIES, `${path}.category`);
  stringValue(value.code, `${path}.code`, { max: 64, pattern: ERROR_CODE });
  stringValue(value.message, `${path}.message`, { max: 512 });
  booleanValue(value.retryable, `${path}.retryable`);
  if (value.details !== undefined) boundedJson(value.details, `${path}.details`);
  return value;
}

export function validateExecution(value) {
  const path = 'execution';
  exactKeys(value, path,
    [...commonRequired, 'executionId', 'requestId', 'deviceId', 'operation', 'state', 'createdAt', 'updatedAt', 'limits'],
    ['idempotencyKey', 'exitCode', 'error']);
  protocolFields(value, path);
  identifier(value.executionId, `${path}.executionId`);
  identifier(value.requestId, `${path}.requestId`);
  identifier(value.deviceId, `${path}.deviceId`);
  const definition = operationDefinition(value.operation);
  oneOf(value.state, COMMANDER_EXECUTION_STATES, `${path}.state`);
  timestamp(value.createdAt, `${path}.createdAt`);
  timestamp(value.updatedAt, `${path}.updatedAt`);
  validateLimits(value.limits, `${path}.limits`);
  if (definition.requiresIdempotencyKey && value.idempotencyKey === undefined) {
    fail('missing_idempotency_key', `${path}.idempotencyKey`);
  }
  if (value.idempotencyKey !== undefined) identifier(value.idempotencyKey, `${path}.idempotencyKey`);
  if (value.exitCode !== undefined) integer(value.exitCode, `${path}.exitCode`, { min: 0, max: 255 });
  if (value.error !== undefined) validateCommanderError(value.error, `${path}.error`);
  if (value.state === 'failed' && value.error === undefined) fail('missing_error', `${path}.error`);
  return value;
}

function validateOutput(value, path) {
  exactKeys(value, path, ['stdout', 'stderr', 'truncated', 'totalBytes']);
  stringValue(value.stdout, `${path}.stdout`, { min: 0, max: COMMANDER_LIMITS.maxOutputBytes });
  stringValue(value.stderr, `${path}.stderr`, { min: 0, max: COMMANDER_LIMITS.maxOutputBytes });
  booleanValue(value.truncated, `${path}.truncated`);
  integer(value.totalBytes, `${path}.totalBytes`, { min: 0 });
  if (Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr) > COMMANDER_LIMITS.maxOutputBytes) {
    fail('output_too_large', path);
  }
}

export function validateOperationResult(value) {
  const path = 'result';
  exactKeys(value, path,
    [...commonRequired, 'requestId', 'deviceId', 'operation', 'ok', 'completedAt'],
    ['executionId', 'data', 'error', 'output']);
  protocolFields(value, path);
  identifier(value.requestId, `${path}.requestId`);
  identifier(value.deviceId, `${path}.deviceId`);
  operationDefinition(value.operation);
  booleanValue(value.ok, `${path}.ok`);
  timestamp(value.completedAt, `${path}.completedAt`);
  if (value.executionId !== undefined) identifier(value.executionId, `${path}.executionId`);
  if (value.data !== undefined) boundedJson(value.data, `${path}.data`, COMMANDER_LIMITS.maxMessageBytes);
  if (value.output !== undefined) validateOutput(value.output, `${path}.output`);
  if (value.error !== undefined) validateCommanderError(value.error, `${path}.error`);
  if (value.ok && value.error !== undefined) fail('unexpected_error', `${path}.error`);
  if (!value.ok && value.error === undefined) fail('missing_error', `${path}.error`);
  return value;
}

export function validateExecutionEvent(value) {
  const path = 'event';
  exactKeys(value, path,
    [...commonRequired, 'eventId', 'executionId', 'requestId', 'deviceId', 'type', 'sequence', 'timestamp', 'payload']);
  protocolFields(value, path);
  identifier(value.eventId, `${path}.eventId`);
  identifier(value.executionId, `${path}.executionId`);
  identifier(value.requestId, `${path}.requestId`);
  identifier(value.deviceId, `${path}.deviceId`);
  oneOf(value.type, COMMANDER_EVENT_TYPES, `${path}.type`);
  integer(value.sequence, `${path}.sequence`, { min: 0 });
  timestamp(value.timestamp, `${path}.timestamp`);
  boundedJson(value.payload, `${path}.payload`, COMMANDER_LIMITS.maxOutputBytes);
  if (value.type === 'state') {
    plainObject(value.payload, `${path}.payload`);
    oneOf(value.payload.state, COMMANDER_EXECUTION_STATES, `${path}.payload.state`);
  }
  if (value.type === 'stdout' || value.type === 'stderr') {
    plainObject(value.payload, `${path}.payload`);
    stringValue(value.payload.chunk, `${path}.payload.chunk`, { min: 0, max: COMMANDER_LIMITS.maxOutputBytes });
  }
  return value;
}

export function commanderError({ category, code, message, retryable = false, details } = {}) {
  const value = {
    ...protocolEnvelope(),
    category,
    code,
    message,
    retryable,
    ...(details === undefined ? {} : { details }),
  };
  return validateCommanderError(value);
}
