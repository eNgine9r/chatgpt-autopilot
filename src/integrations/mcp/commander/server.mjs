import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  commanderError,
  operationDefinition,
  protocolEnvelope,
  validateCommanderError,
  validateOperationResult,
} from '../../../commander/contracts/index.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const DESCRIPTIONS = Object.freeze({
  'device.health': 'Read bounded health information from the selected Commander device.',
  'file.read': 'Read an allowlisted file from the selected Commander device.',
  'file.list': 'List an allowlisted directory on the selected Commander device.',
  'file.info': 'Read metadata for an allowlisted path on the selected Commander device.',
  'file.search': 'Search allowlisted project files on the selected Commander device.',
  'process.list': 'List bounded process metadata on the selected Commander device.',
  'service.status': 'Read status for an allowlisted user service.',
  'git.status': 'Read Git working-tree status for an allowlisted repository.',
  'git.diff': 'Read a bounded Git diff for an allowlisted repository.',
  'git.log': 'Read bounded Git history for an allowlisted repository.',
  'work_session.list': 'List persisted Commander work sessions on the selected device.',
  'work_session.get': 'Read a persisted Commander work-session checkpoint.',
  'work_session.resume': 'Resume a persisted Commander work session and detect repository divergence.',
  'execution.get': 'Read the state of a Commander-owned execution.',
  'execution.output': 'Read bounded output events from a Commander-owned execution.',
  'execution.start': 'Start a fixed-alias Commander execution. Requires an idempotency key.',
  'execution.input': 'Send bounded input to a Commander-owned execution. Requires an idempotency key.',
  'execution.cancel': 'Cancel a Commander-owned execution. Requires an idempotency key.',
  'file.write': 'Write an allowlisted project file through Commander policy. Requires an idempotency key and may require approval.',
  'file.edit': 'Apply a controlled edit to an allowlisted project file. Requires an idempotency key and may require approval.',
  'file.move': 'Move an allowlisted project file through Commander policy. Requires an idempotency key and may require approval.',
  'file.delete': 'Delete an allowlisted project file through Commander policy. Requires an idempotency key and may require approval.',
  'directory.create': 'Create one allowlisted project directory through Commander policy. Requires an idempotency key and may require approval.',
  'directory.remove': 'Remove one empty allowlisted project directory through Commander policy. Requires an idempotency key and may require approval.',
  'service.start': 'Start an allowlisted user service through Commander policy. Requires an idempotency key and may require approval.',
  'service.stop': 'Stop an allowlisted user service through Commander policy. Requires an idempotency key and may require approval.',
  'service.restart': 'Restart an allowlisted user service through Commander policy. Requires an idempotency key and may require approval.',
  'git.commit': 'Create an allowlisted Git commit through Commander policy. Requires an idempotency key and may require approval.',
  'git.push': 'Push an allowlisted Git branch through Commander policy. Requires an idempotency key and may require approval.',
  'work_session.open': 'Open a persistent device/project/workspace session. Requires an idempotency key.',
  'work_session.checkpoint': 'Checkpoint the current persistent work session and re-sync repository state. Requires an idempotency key.',
  'work_session.close': 'Close a persistent work session while keeping its final checkpoint. Requires an idempotency key.',
});

function toolName(operation) {
  return `commander_v1_${operation.replaceAll('.', '_')}`;
}

function correlationRequestId(operation, ctx) {
  const upstream = String(ctx?.mcpReq?.id ?? 'unknown');
  const digest = crypto.createHash('sha256').update(`${operation}:${upstream}`).digest('hex').slice(0, 16);
  const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  return `mcp-${digest}-${nonce}`;
}

function safeCommanderError(error) {
  if (error?.commanderError) {
    try { return validateCommanderError(error.commanderError); } catch { /* fall through */ }
  }
  const code = String(error?.code || error?.message || '');
  if (code === 'control_request_cancelled') {
    return commanderError({ category: 'cancelled', code: 'MCP_REQUEST_CANCELLED', message: 'MCP request was cancelled', retryable: false });
  }
  if (code === 'control_request_timeout') {
    return commanderError({ category: 'timeout', code: 'MCP_CONTROL_TIMEOUT', message: 'Commander control request timed out', retryable: true });
  }
  return commanderError({ category: 'transport', code: 'MCP_COMMANDER_UNAVAILABLE', message: 'Commander public client request failed', retryable: true });
}

function failedResult({ requestId, deviceId, operation, error }) {
  return validateOperationResult({
    ...protocolEnvelope(),
    requestId,
    deviceId,
    operation,
    ok: false,
    completedAt: new Date().toISOString(),
    error: safeCommanderError(error),
  });
}

function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    ...(result.ok ? {} : { isError: true }),
  };
}

function capabilityStillEnabled(snapshot, operation) {
  return snapshot?.status === 'online'
    && snapshot?.device?.capabilities?.some((capability) => capability.operation === operation);
}

function inputSchemaFor(definition, { requireDeviceId = false } = {}) {
  const shape = {
    ...(requireDeviceId ? { deviceId: z.string().min(1).max(128).regex(ID) } : {}),
    params: z.record(z.string(), z.json()).default({}),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
    workSessionId: z.string().min(1).max(128).regex(ID).optional(),
  };
  if (definition.requiresIdempotencyKey) {
    shape.idempotencyKey = z.string().min(1).max(128).regex(ID);
  }
  return z.object(shape).strict();
}

export function commanderMcpToolNames(deviceEntry) {
  if (!deviceEntry || deviceEntry.status !== 'online' || !Array.isArray(deviceEntry.device?.capabilities)) return [];
  return deviceEntry.device.capabilities
    .filter((capability) => capability.authority !== 'admin')
    .map((capability) => toolName(capability.operation));
}

function eligibleCapabilities(entries = []) {
  const byOperation = new Map();
  for (const entry of entries) {
    if (!entry || entry.status !== 'online' || !Array.isArray(entry.device?.capabilities)) continue;
    for (const capability of entry.device.capabilities) {
      const definition = operationDefinition(capability.operation);
      if (definition.authority === 'admin' || capability.authority !== definition.authority || capability.operationVersion !== definition.operationVersion) continue;
      if (!byOperation.has(capability.operation)) byOperation.set(capability.operation, capability);
    }
  }
  return [...byOperation.values()];
}

function boundedDeviceList(entries = []) {
  return entries.slice(0, 64).map((entry) => ({
    deviceId: String(entry?.device?.deviceId || '').slice(0, 128),
    displayName: String(entry?.device?.displayName || '').slice(0, 160),
    status: entry?.status === 'online' ? 'online' : 'offline',
    capabilities: eligibleCapabilities([entry]).map((capability) => capability.operation).slice(0, 64),
  })).filter((entry) => ID.test(entry.deviceId));
}

export function buildCommanderMcpServer({ client, deviceId, deviceEntry, deviceEntries = [], multiDevice = false } = {}) {
  if (!client || typeof client.request !== 'function' || typeof client.getDevice !== 'function') throw new Error('commander_public_client_required');
  if (multiDevice) {
    if (typeof client.listDevices !== 'function') throw new Error('commander_public_client_list_required');
    if (!Array.isArray(deviceEntries)) throw new Error('invalid_commander_mcp_device_entries');
  } else {
    if (typeof deviceId !== 'string' || !ID.test(deviceId)) throw new Error('invalid_commander_mcp_device_id');
    if (!deviceEntry || deviceEntry.status !== 'online' || deviceEntry.device?.deviceId !== deviceId) throw new Error('commander_mcp_device_offline');
  }

  const server = new McpServer(
    { name: 'chatgpt-autopilot-commander', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  if (multiDevice) {
    server.registerTool('commander_v1_device_list', {
      title: 'Commander device.list',
      description: 'List bounded Commander device metadata and currently advertised non-admin capabilities.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => {
      try {
        const current = await client.listDevices();
        const entries = Array.isArray(current) ? current : current?.devices;
        if (!Array.isArray(entries)) throw new Error('commander_mcp_device_list_invalid');
        const data = { devices: boundedDeviceList(entries) };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      } catch {
        const data = { devices: [], error: 'COMMANDER_DEVICE_LIST_UNAVAILABLE' };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: true };
      }
    });
  }

  const advertisedCapabilities = multiDevice ? eligibleCapabilities(deviceEntries) : eligibleCapabilities([deviceEntry]);
  for (const capability of advertisedCapabilities) {
    const definition = operationDefinition(capability.operation);
    const operation = capability.operation;
    server.registerTool(toolName(operation), {
      title: `Commander ${operation}`,
      description: DESCRIPTIONS[operation] || `Run Commander operation ${operation} on the selected device.`,
      inputSchema: inputSchemaFor(definition, { requireDeviceId: multiDevice }),
      annotations: {
        readOnlyHint: definition.authority === 'read',
        destructiveHint: definition.authority !== 'read',
        idempotentHint: definition.requiresIdempotencyKey,
        openWorldHint: false,
      },
    }, async (args, ctx) => {
      const selectedDeviceId = multiDevice ? String(args.deviceId || '') : deviceId;
      const requestId = correlationRequestId(operation, ctx);
      try {
        if (!ID.test(selectedDeviceId)) throw new Error('invalid_commander_mcp_device_id');
        const current = await client.getDevice(selectedDeviceId, { signal: ctx?.mcpReq?.signal });
        if (!capabilityStillEnabled(current, operation)) {
          throw Object.assign(new Error('operation_not_advertised'), {
            commanderError: commanderError({
              category: 'authorization', code: 'OPERATION_NOT_ADVERTISED',
              message: 'Operation is not enabled for the current Commander device session', retryable: false,
            }),
          });
        }
        const request = {
          ...protocolEnvelope(), requestId, deviceId: selectedDeviceId, operation, params: args.params,
          ...(definition.requiresIdempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
          ...(args.workSessionId ? { workSessionId: args.workSessionId } : {}),
          ...(args.timeoutMs ? { deadlineAt: new Date(Date.now() + args.timeoutMs).toISOString() } : {}),
        };
        const result = await client.request(request, { timeoutMs: args.timeoutMs, signal: ctx?.mcpReq?.signal });
        return toolResult(validateOperationResult(result));
      } catch (error) {
        return toolResult(failedResult({ requestId, deviceId: selectedDeviceId, operation, error }));
      }
    });
  }

  return server;
}
