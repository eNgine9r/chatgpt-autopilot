import {
  commanderError, operationDefinition, protocolEnvelope, validateOperationRequest, validateOperationResult,
} from '../contracts/index.mjs';
import { PHASE3_READ_OPERATIONS } from './read-policy.mjs';
import { fileInfoData, listFileData, readFileData, searchFileData } from './read-files.mjs';
import {
  deviceHealthData, gitDiffData, gitLogData, gitStatusData, processListData, serviceStatusData,
} from './read-system.mjs';
import { runReadCommand } from './read-command.mjs';

const ALLOWED = new Set(PHASE3_READ_OPERATIONS);

function errorCode(error) {
  const raw = String(error?.message || 'READ_INTERNAL_ERROR').replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(raw) ? raw : 'READ_INTERNAL_ERROR';
}

function errorCategory(code) {
  if (code.startsWith('READ_POLICY_')) return 'policy';
  if (code.includes('NOT_FOUND')) return 'not_found';
  if (code.includes('TIMEOUT')) return 'timeout';
  if (code.startsWith('READ_PARAMS_') || code.includes('INVALID')) return 'validation';
  if (code === 'READ_OPERATION_NOT_ENABLED' || code === 'READ_OPERATION_AUTHORITY_DENIED') return 'authorization';
  return 'execution';
}

export class CommanderReadOnlyDispatcher {
  constructor({ deviceId, policy, commandRunner = runReadCommand, now = Date.now, logger = console } = {}) {
    if (!deviceId || !policy) throw new Error('readonly_dispatcher_config_required');
    this.deviceId = deviceId;
    this.policy = policy;
    this.commandRunner = commandRunner;
    this.now = now;
    this.logger = logger;
  }

  async handle(input) {
    const request = validateOperationRequest(input);
    const definition = operationDefinition(request.operation);
    if (request.deviceId !== this.deviceId) return this.#failure(request, 'READ_DEVICE_MISMATCH');
    if (definition.authority !== 'read') return this.#failure(request, 'READ_OPERATION_AUTHORITY_DENIED');
    if (!ALLOWED.has(request.operation)) return this.#failure(request, 'READ_OPERATION_NOT_ENABLED');
    if (request.deadlineAt && Date.parse(request.deadlineAt) <= this.now()) return this.#failure(request, 'READ_REQUEST_DEADLINE_EXPIRED');
    try {
      let data;
      switch (request.operation) {
        case 'device.health': data = deviceHealthData(request.params); break;
        case 'file.read': data = await readFileData(this.policy, request.params); break;
        case 'file.list': data = await listFileData(this.policy, request.params); break;
        case 'file.info': data = await fileInfoData(this.policy, request.params); break;
        case 'file.search': data = await searchFileData(this.policy, request.params); break;
        case 'process.list': data = await processListData(request.params); break;
        case 'service.status': data = await serviceStatusData(this.policy, request.params, this.commandRunner); break;
        case 'git.status': data = await gitStatusData(this.policy, request.params, this.commandRunner); break;
        case 'git.diff': data = await gitDiffData(this.policy, request.params, this.commandRunner); break;
        case 'git.log': data = await gitLogData(this.policy, request.params, this.commandRunner); break;
        default: return this.#failure(request, 'READ_OPERATION_NOT_ENABLED');
      }
      const result = validateOperationResult({
        ...protocolEnvelope(), requestId: request.requestId, deviceId: this.deviceId,
        operation: request.operation, ok: true, completedAt: new Date(this.now()).toISOString(), data,
      });
      try { this.logger?.info?.('commander_read_operation_audit', { requestId: request.requestId, operation: request.operation, ok: true }); } catch {}
      return result;
    } catch (error) {
      return this.#failure(request, errorCode(error));
    }
  }

  #failure(request, code) {
    const result = validateOperationResult({
      ...protocolEnvelope(), requestId: request.requestId, deviceId: this.deviceId,
      operation: request.operation, ok: false, completedAt: new Date(this.now()).toISOString(),
      error: commanderError({
        category: errorCategory(code), code, message: 'Commander read operation was not completed.', retryable: code.includes('TIMEOUT'),
      }),
    });
    try { this.logger?.warn?.('commander_read_operation_audit', { requestId: request.requestId, operation: request.operation, ok: false, code }); } catch {}
    return result;
  }
}
