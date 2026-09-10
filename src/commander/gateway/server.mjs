import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import {
  operationDefinition, protocolEnvelope, validateDevice, validateExecutionEvent, validateOperationRequest, validateOperationResult,
} from '../contracts/index.mjs';
import { createChallenge, verifyRegistrationProof } from '../session/auth.mjs';
import { encodeJsonLine, JsonLineDecoder } from '../session/framing.mjs';
import { resolveCommanderGatewayBindHost } from '../config.mjs';
import { CommanderDeviceRegistry } from './device-registry.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function log(logger, level, event, fields = {}) {
  try { logger?.[level]?.(event, fields); } catch { /* logging must not affect session state */ }
}

function exactMessage(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_session_message');
  const allowed = new Set(['protocol', 'protocolVersion', 'minProtocolVersion', ...required]);
  for (const key of ['protocol', 'protocolVersion', 'minProtocolVersion', ...required]) {
    if (!Object.hasOwn(value, key)) throw new Error(`missing_session_field:${key}`);
  }
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown_session_field:${key}`);
  if (value.protocol !== 'commander' || value.protocolVersion !== 1 || value.minProtocolVersion !== 1) {
    throw new Error('invalid_session_protocol');
  }
}

function validId(value) { return typeof value === 'string' && ID.test(value); }
function validTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

export class CommanderGatewayServer extends EventEmitter {
  constructor(options = {}) {
    super();
    if (typeof options.secretResolver !== 'function') throw new Error('secret_resolver_required');
    this.host = resolveCommanderGatewayBindHost(options.host ?? '127.0.0.1', {
      privateBindEnabled: options.privateBindEnabled === true,
      networkInterfaces: options.networkInterfaces,
    });
    this.port = Number(options.port ?? 0);
    this.secretResolver = options.secretResolver;
    this.registry = options.registry ?? new CommanderDeviceRegistry({ heartbeatTimeoutMs: options.heartbeatTimeoutMs });
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? crypto.randomBytes;
    this.heartbeatIntervalMs = Number(options.heartbeatIntervalMs ?? 5_000);
    this.heartbeatTimeoutMs = Number(options.heartbeatTimeoutMs ?? 20_000);
    this.authTimeoutMs = Number(options.authTimeoutMs ?? 10_000);
    this.allowedAuthorities = new Set(options.allowedAuthorities ?? ['read']);
    for (const authority of this.allowedAuthorities) if (!['read', 'write'].includes(authority)) throw new Error('invalid_gateway_authority');
    this.executionEvents = new Map();
    this.server = null;
    this.sockets = new Set();
    this.pendingRequests = new Map();
    this.expiryTimer = null;
  }

  async start() {
    if (this.server) throw new Error('gateway_already_started');
    const server = net.createServer((socket) => this.#accept(socket));
    server.maxConnections = this.registry.maxDevices * 2;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: this.host, port: this.port }, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.expiryTimer = setInterval(() => {
      for (const deviceId of this.registry.expireStale()) {
        log(this.logger, 'warn', 'commander_device_heartbeat_expired', { deviceId });
      }
    }, Math.max(250, Math.floor(this.heartbeatIntervalMs / 2)));
    this.expiryTimer.unref?.();
    return this.address();
  }

  address() {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address : null;
  }

  async stop() {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = null;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('gateway_stopped'));
    }
    this.pendingRequests.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }


  request(input, options = {}) {
    const request = validateOperationRequest(input);
    const definition = operationDefinition(request.operation);
    if (!this.allowedAuthorities.has(definition.authority)) throw new Error(definition.authority === 'read' ? 'gateway_authority_disabled' : 'gateway_read_only');
    const entry = this.registry.get(request.deviceId);
    if (!entry || entry.status !== 'online' || !entry.connection || entry.connection.destroyed) throw new Error('device_offline');
    const capability = entry.device.capabilities.find((item) => item.operation === request.operation);
    if (!capability || capability.authority !== definition.authority || capability.operationVersion !== definition.operationVersion) {
      throw new Error('operation_not_advertised');
    }
    if (this.pendingRequests.has(request.requestId)) throw new Error('duplicate_request_id');
    let timeoutMs = Number(options.timeoutMs ?? 10_000);
    if (request.deadlineAt) timeoutMs = Math.min(timeoutMs, Math.max(0, Date.parse(request.deadlineAt) - this.now()));
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error('invalid_gateway_request_timeout');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(request.requestId);
        reject(new Error('gateway_request_timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRequests.set(request.requestId, {
        request, sessionId: entry.sessionId, resolve, reject, timer,
      });
      try {
        entry.connection.write(encodeJsonLine({
          ...protocolEnvelope(), type: 'operation_request', sessionId: entry.sessionId, request,
        }));
        const kind = definition.authority === 'read' ? 'read' : (request.operation.startsWith('execution.') ? 'execution' : 'write');
        log(this.logger, 'info', `commander_${kind}_request_sent`, {
          deviceId: request.deviceId, requestId: request.requestId, operation: request.operation,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(request.requestId);
        reject(error);
      }
    });
  }

  #rejectPendingSession(deviceId, sessionId, reason) {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.request.deviceId === deviceId && pending.sessionId === sessionId) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(requestId);
        pending.reject(new Error(reason));
      }
    }
  }

  #accept(socket) {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    const decoder = new JsonLineDecoder();
    const challenge = createChallenge({ now: this.now, randomBytes: this.randomBytes });
    const state = { stage: 'challenge', deviceId: '', sessionId: '', queue: Promise.resolve() };
    const authTimer = setTimeout(() => socket.destroy(new Error('registration_timeout')), this.authTimeoutMs);
    authTimer.unref?.();
    socket.write(encodeJsonLine(challenge));

    const close = (reason) => {
      clearTimeout(authTimer);
      if (state.deviceId && state.sessionId) {
        this.registry.disconnect(state.deviceId, state.sessionId);
        this.#rejectPendingSession(state.deviceId, state.sessionId, 'device_offline');
      }
      this.sockets.delete(socket);
      log(this.logger, 'info', 'commander_agent_disconnected', {
        deviceId: state.deviceId || undefined,
        sessionId: state.sessionId || undefined,
        reason,
      });
    };

    socket.on('data', (chunk) => {
      let messages;
      try { messages = decoder.push(chunk); } catch (error) {
        log(this.logger, 'warn', 'commander_session_frame_rejected', { error: String(error.message || error) });
        socket.destroy();
        return;
      }
      for (const message of messages) {
        state.queue = state.queue.then(() => this.#message(socket, state, challenge, message, authTimer))
          .catch((error) => {
            log(this.logger, 'warn', 'commander_session_rejected', {
              deviceId: state.deviceId || undefined,
              error: String(error.message || error),
            });
            socket.destroy();
          });
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => close('socket_closed'));
  }

  async #message(socket, state, challenge, message, authTimer) {
    if (state.stage === 'challenge') {
      exactMessage(message, ['type', 'challengeId', 'device', 'proof']);
      if (message.type !== 'register' || message.challengeId !== challenge.challengeId) throw new Error('invalid_registration_challenge');
      const device = validateDevice(message.device);
      const secret = await this.secretResolver(device.deviceId);
      if (!secret || !verifyRegistrationProof(secret, challenge, device, message.proof, { now: this.now })) {
        throw new Error('invalid_registration_proof');
      }
      const sessionId = `session-${this.randomBytes(16).toString('hex')}`;
      const { previous } = this.registry.register(device, sessionId, socket);
      state.stage = 'active';
      state.deviceId = device.deviceId;
      state.sessionId = sessionId;
      clearTimeout(authTimer);
      if (previous?.connection && previous.connection !== socket) previous.connection.destroy();
      socket.write(encodeJsonLine({
        ...protocolEnvelope(),
        type: 'registered',
        deviceId: device.deviceId,
        sessionId,
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        heartbeatTimeoutMs: this.heartbeatTimeoutMs,
        registeredAt: new Date(this.now()).toISOString(),
      }));
      log(this.logger, 'info', 'commander_agent_registered', { deviceId: device.deviceId, sessionId });
      return;
    }

    if (message.type === 'heartbeat') {
      exactMessage(message, ['type', 'deviceId', 'sessionId', 'sequence', 'timestamp']);
      if (message.deviceId !== state.deviceId || message.sessionId !== state.sessionId) throw new Error('heartbeat_session_mismatch');
      if (!Number.isSafeInteger(message.sequence) || message.sequence < 0 || !validTimestamp(message.timestamp)) throw new Error('invalid_heartbeat');
      this.registry.heartbeat(message.deviceId, message.sessionId, message.sequence);
      socket.write(encodeJsonLine({
        ...protocolEnvelope(), type: 'heartbeat_ack', deviceId: state.deviceId,
        sessionId: state.sessionId, sequence: message.sequence, timestamp: new Date(this.now()).toISOString(),
      }));
      return;
    }

    if (message.type === 'execution_event') {
      exactMessage(message, ['type', 'sessionId', 'event']);
      if (message.sessionId !== state.sessionId) throw new Error('execution_event_session_mismatch');
      const event = validateExecutionEvent(message.event);
      if (event.deviceId !== state.deviceId) throw new Error('execution_event_device_mismatch');
      const history = this.executionEvents.get(event.executionId) ?? [];
      history.push(event);
      if (history.length > 1024) history.shift();
      this.executionEvents.set(event.executionId, history);
      while (this.executionEvents.size > 256) this.executionEvents.delete(this.executionEvents.keys().next().value);
      this.emit('executionEvent', event);
      return;
    }

    if (message.type === 'operation_result') {
      exactMessage(message, ['type', 'sessionId', 'result']);
      if (message.sessionId !== state.sessionId) throw new Error('operation_result_session_mismatch');
      const result = validateOperationResult(message.result);
      if (result.deviceId !== state.deviceId) throw new Error('operation_result_device_mismatch');
      const pending = this.pendingRequests.get(result.requestId);
      if (!pending || pending.sessionId !== state.sessionId || pending.request.operation !== result.operation) {
        throw new Error('stale_or_unknown_operation_result');
      }
      clearTimeout(pending.timer);
      this.pendingRequests.delete(result.requestId);
      pending.resolve(result);
      const resultDefinition = operationDefinition(result.operation);
      const kind = resultDefinition.authority === 'read' ? 'read' : (result.operation.startsWith('execution.') ? 'execution' : 'write');
      log(this.logger, 'info', `commander_${kind}_request_completed`, {
        deviceId: result.deviceId, requestId: result.requestId, operation: result.operation, ok: result.ok,
      });
      return;
    }

    if (message.type === 'goodbye') {
      exactMessage(message, ['type', 'deviceId', 'sessionId']);
      if (!validId(message.deviceId) || !validId(message.sessionId) || message.deviceId !== state.deviceId || message.sessionId !== state.sessionId) {
        throw new Error('goodbye_session_mismatch');
      }
      this.registry.disconnect(state.deviceId, state.sessionId);
      socket.end();
      return;
    }
    throw new Error('unsupported_session_message');
  }
}
