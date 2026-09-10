import {
  CommanderContractViolation,
  commanderError,
  validateCommanderError,
  validateOperationRequest,
} from './contracts/index.mjs';

export const COMMANDER_CONTROL_PROTOCOL = Object.freeze({ name: 'commander-control', version: 1 });
export const COMMANDER_CONTROL_MAX_FRAME_BYTES = 512 * 1024;
export const COMMANDER_CONTROL_METHODS = Object.freeze(['device.list', 'device.get', 'operation.request']);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function plainObject(value, code = 'invalid_control_message') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value;
}

function exactKeys(value, required, optional = []) {
  plainObject(value);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`missing_control_field:${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown_control_field:${key}`);
}

function controlEnvelope() {
  return { protocol: COMMANDER_CONTROL_PROTOCOL.name, protocolVersion: COMMANDER_CONTROL_PROTOCOL.version };
}

function validateId(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`invalid_control_${field}`);
  return value;
}

function validateBase(value, required, optional = []) {
  exactKeys(value, ['protocol', 'protocolVersion', ...required], optional);
  if (value.protocol !== COMMANDER_CONTROL_PROTOCOL.name || value.protocolVersion !== COMMANDER_CONTROL_PROTOCOL.version) {
    throw new Error('unsupported_control_protocol');
  }
}

function validateParams(method, params) {
  plainObject(params, 'invalid_control_params');
  if (method === 'device.list') {
    exactKeys(params, []);
    return;
  }
  if (method === 'device.get') {
    exactKeys(params, ['deviceId']);
    validateId(params.deviceId, 'device_id');
    return;
  }
  if (method === 'operation.request') {
    exactKeys(params, ['request'], ['timeoutMs']);
    validateOperationRequest(params.request);
    if (params.timeoutMs !== undefined && (!Number.isInteger(params.timeoutMs) || params.timeoutMs < 100 || params.timeoutMs > 30_000)) {
      throw new Error('invalid_control_timeout');
    }
    return;
  }
  throw new Error('unsupported_control_method');
}

export function controlRequest({ requestId, method, params }) {
  const value = { ...controlEnvelope(), requestId, method, params };
  return validateControlRequest(value);
}

export function validateControlRequest(value) {
  validateBase(value, ['requestId', 'method', 'params']);
  validateId(value.requestId, 'request_id');
  if (!COMMANDER_CONTROL_METHODS.includes(value.method)) throw new Error('unsupported_control_method');
  validateParams(value.method, value.params);
  return value;
}

export function controlSuccess(requestId, result) {
  return { ...controlEnvelope(), requestId: validateId(requestId, 'request_id'), ok: true, result };
}

export function controlFailure(requestId, error) {
  return {
    ...controlEnvelope(), requestId: validateId(requestId, 'request_id'), ok: false,
    error: validateCommanderError(error, 'control.error'),
  };
}

export function validateControlResponse(value) {
  validateBase(value, ['requestId', 'ok'], value?.ok === true ? ['result'] : ['error']);
  validateId(value.requestId, 'request_id');
  if (typeof value.ok !== 'boolean') throw new Error('invalid_control_response_ok');
  if (value.ok) {
    if (!Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error')) throw new Error('invalid_control_success');
  } else {
    if (!Object.hasOwn(value, 'error') || Object.hasOwn(value, 'result')) throw new Error('invalid_control_failure');
    validateCommanderError(value.error, 'control.error');
  }
  return value;
}

const ERROR_MAP = new Map([
  ['device_offline', ['device_offline', 'DEVICE_OFFLINE', true]],
  ['device_not_found', ['not_found', 'DEVICE_NOT_FOUND', false]],
  ['gateway_request_timeout', ['timeout', 'GATEWAY_REQUEST_TIMEOUT', true]],
  ['gateway_stopped', ['transport', 'GATEWAY_STOPPED', true]],
  ['gateway_read_only', ['authorization', 'GATEWAY_WRITE_DISABLED', false]],
  ['gateway_authority_disabled', ['authorization', 'GATEWAY_AUTHORITY_DISABLED', false]],
  ['operation_not_advertised', ['authorization', 'OPERATION_NOT_ADVERTISED', false]],
  ['duplicate_request_id', ['conflict', 'DUPLICATE_REQUEST_ID', true]],
  ['unsupported_control_method', ['validation', 'UNSUPPORTED_CONTROL_METHOD', false]],
]);

export function commanderErrorFromControlFailure(error) {
  if (error?.commanderError) {
    try { return validateCommanderError(error.commanderError); } catch { /* map below */ }
  }
  const raw = String(error?.message || error || '');
  if (error instanceof CommanderContractViolation || raw.includes(':request.')) {
    return commanderError({ category: 'validation', code: 'INVALID_COMMANDER_REQUEST', message: 'Commander request validation failed' });
  }
  const mapped = ERROR_MAP.get(raw);
  if (mapped) {
    const [category, code, retryable] = mapped;
    return commanderError({ category, code, message: raw, retryable });
  }
  if (/^(invalid_|missing_|unknown_|unsupported_control_)/.test(raw)) {
    return commanderError({ category: 'validation', code: 'INVALID_CONTROL_REQUEST', message: 'Commander control request validation failed' });
  }
  return commanderError({ category: 'internal', code: 'COMMANDER_CONTROL_ERROR', message: 'Commander control request failed', retryable: false });
}
