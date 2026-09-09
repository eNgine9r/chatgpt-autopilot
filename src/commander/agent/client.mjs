import { EventEmitter } from 'node:events';
import net from 'node:net';
import {
  commanderError, operationDefinition, protocolEnvelope, validateDevice, validateOperationRequest, validateOperationResult,
} from '../contracts/index.mjs';
import { createRegistrationProof, validateChallenge } from '../session/auth.mjs';
import { encodeJsonLine, JsonLineDecoder } from '../session/framing.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function reconnectDelayMs(attempt, options = {}) {
  const baseMs = Number(options.baseMs ?? 500);
  const maxMs = Number(options.maxMs ?? 30_000);
  const jitterRatio = Number(options.jitterRatio ?? 0.2);
  const random = options.random ?? Math.random;
  if (!Number.isInteger(attempt) || attempt < 0 || baseMs < 100 || maxMs < baseMs || jitterRatio < 0 || jitterRatio > 0.5) {
    throw new Error('invalid_reconnect_policy');
  }
  const raw = Math.min(maxMs, baseMs * (2 ** Math.min(attempt, 16)));
  const jitter = raw * jitterRatio * ((random() * 2) - 1);
  return Math.max(100, Math.round(raw + jitter));
}

function log(logger, level, event, fields = {}) {
  try { logger?.[level]?.(event, fields); } catch { /* ignore logger failures */ }
}

function validId(value) { return typeof value === 'string' && ID.test(value); }

function exactGatewayMessage(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_gateway_message');
  const fields = ['protocol', 'protocolVersion', 'minProtocolVersion', ...required];
  const allowed = new Set(fields);
  for (const key of fields) if (!Object.hasOwn(value, key)) throw new Error(`missing_gateway_field:${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown_gateway_field:${key}`);
  if (value.protocol !== 'commander' || value.protocolVersion !== 1 || value.minProtocolVersion !== 1) throw new Error('invalid_gateway_protocol');
}

export class CommanderAgentClient extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.identity?.deviceId) throw new Error('agent_identity_required');
    if (!options.secret) throw new Error('agent_secret_required');
    this.gatewayHost = options.gatewayHost ?? '127.0.0.1';
    this.gatewayPort = Number(options.gatewayPort ?? 8790);
    this.identity = options.identity;
    this.secret = options.secret;
    this.agentVersion = options.agentVersion ?? '0.1.0';
    this.displayName = options.displayName;
    this.capabilities = options.capabilities ?? [];
    this.operationHandler = options.operationHandler ?? null;
    this.allowedAuthorities = new Set(options.allowedAuthorities ?? ['read']);
    for (const authority of this.allowedAuthorities) if (!['read', 'write'].includes(authority)) throw new Error('invalid_agent_authority');
    this.executionEventSource = options.executionEventSource ?? null;
    this.executionEventListener = (event) => this.#sendExecutionEvent(event);
    this.executionEventSource?.on?.('event', this.executionEventListener);
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.connector = options.connector ?? ((connectOptions) => net.createConnection(connectOptions));
    this.random = options.random ?? Math.random;
    this.reconnectPolicy = {
      baseMs: options.reconnectBaseMs ?? 500,
      maxMs: options.reconnectMaxMs ?? 30_000,
      jitterRatio: options.reconnectJitterRatio ?? 0.2,
      random: this.random,
    };
    this.connectTimeoutMs = Number(options.connectTimeoutMs ?? 5_000);
    this.socket = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.reconnectAttempt = 0;
    this.sessionId = '';
    this.sequence = 0;
    this.lastAckSequence = -1;
    this.lastAckAt = 0;
    this.heartbeatIntervalMs = 0;
    this.heartbeatTimeoutMs = 0;
    this.state = 'stopped';
    this.stopping = true;
  }

  device() {
    return validateDevice({
      ...protocolEnvelope(),
      deviceId: this.identity.deviceId,
      ...(this.displayName ? { displayName: this.displayName } : {}),
      platform: 'linux',
      agentVersion: this.agentVersion,
      capabilities: this.capabilities,
    });
  }

  start() {
    if (!this.stopping) throw new Error('agent_already_started');
    this.stopping = false;
    this.reconnectAttempt = 0;
    this.#setState('disconnected');
    this.#connect();
  }

  async stop() {
    if (this.stopping && this.state === 'stopped') return;
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) {
      if (this.sessionId) {
        try {
          socket.write(encodeJsonLine({
            ...protocolEnvelope(), type: 'goodbye', deviceId: this.identity.deviceId, sessionId: this.sessionId,
          }));
        } catch { /* close regardless */ }
      }
      socket.end();
      setTimeout(() => socket.destroy(), 250).unref?.();
    }
    this.sessionId = '';
    this.#setState('stopped');
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
    log(this.logger, 'info', 'commander_agent_state', { deviceId: this.identity.deviceId, state });
  }

  #connect() {
    if (this.stopping || this.socket) return;
    this.#setState('connecting');
    const socket = this.connector({ host: this.gatewayHost, port: this.gatewayPort });
    this.socket = socket;
    const decoder = new JsonLineDecoder();
    let queue = Promise.resolve();
    let registered = false;
    socket.setNoDelay?.(true);
    socket.setTimeout?.(this.connectTimeoutMs, () => {
      if (!registered) socket.destroy(new Error('connect_timeout'));
    });
    socket.on('connect', () => this.#setState('authenticating'));
    socket.on('data', (chunk) => {
      let messages;
      try { messages = decoder.push(chunk); } catch (error) {
        log(this.logger, 'warn', 'commander_agent_frame_rejected', { error: String(error.message || error) });
        socket.destroy();
        return;
      }
      for (const message of messages) {
        queue = queue.then(async () => {
          if (message.type === 'challenge') {
            validateChallenge(message, { now: this.now });
            const device = this.device();
            socket.write(encodeJsonLine({
              ...protocolEnvelope(), type: 'register', challengeId: message.challengeId,
              device, proof: createRegistrationProof(this.secret, message, device, { now: this.now }),
            }));
            return;
          }
          if (message.type === 'registered') {
            this.#registered(socket, message);
            registered = true;
            socket.setTimeout?.(0);
            return;
          }
          if (message.type === 'heartbeat_ack') {
            this.#heartbeatAck(message);
            return;
          }
          if (message.type === 'operation_request') {
            await this.#operationRequest(socket, message);
            return;
          }
          throw new Error('unsupported_gateway_message');
        }).catch((error) => {
          log(this.logger, 'warn', 'commander_agent_message_rejected', { error: String(error.message || error) });
          socket.destroy();
        });
      }
    });
    socket.on('error', (error) => {
      log(this.logger, 'warn', 'commander_agent_socket_error', { error: String(error.message || error) });
    });
    socket.on('close', () => {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (this.socket === socket) this.socket = null;
      this.sessionId = '';
      if (this.stopping) return;
      this.#setState('disconnected');
      this.#scheduleReconnect();
    });
  }

  #registered(socket, message) {
    if (message.protocol !== 'commander' || message.protocolVersion !== 1 || message.minProtocolVersion !== 1 || message.type !== 'registered') {
      throw new Error('invalid_registered_protocol');
    }
    if (message.deviceId !== this.identity.deviceId || !validId(message.sessionId)) throw new Error('invalid_registered_identity');
    const interval = Number(message.heartbeatIntervalMs);
    const timeout = Number(message.heartbeatTimeoutMs);
    if (!Number.isInteger(interval) || interval < 250 || interval > 60_000 || !Number.isInteger(timeout) || timeout < interval * 2 || timeout > 300_000) {
      throw new Error('invalid_heartbeat_policy');
    }
    this.sessionId = message.sessionId;
    this.heartbeatIntervalMs = interval;
    this.heartbeatTimeoutMs = timeout;
    this.sequence = 0;
    this.lastAckSequence = -1;
    this.lastAckAt = this.now();
    this.reconnectAttempt = 0;
    this.#setState('online');
    this.emit('registered', { deviceId: message.deviceId, sessionId: message.sessionId });
    this.#sendHeartbeat(socket);
    this.heartbeatTimer = setInterval(() => this.#sendHeartbeat(socket), interval);
    this.heartbeatTimer.unref?.();
  }

  #sendHeartbeat(socket) {
    if (this.stopping || this.socket !== socket || !this.sessionId || socket.destroyed) return;
    if (this.lastAckAt && this.now() - this.lastAckAt > this.heartbeatTimeoutMs) {
      socket.destroy(new Error('heartbeat_ack_timeout'));
      return;
    }
    const sequence = this.sequence++;
    socket.write(encodeJsonLine({
      ...protocolEnvelope(), type: 'heartbeat', deviceId: this.identity.deviceId,
      sessionId: this.sessionId, sequence, timestamp: new Date(this.now()).toISOString(),
    }));
  }

  #heartbeatAck(message) {
    if (message.protocol !== 'commander' || message.protocolVersion !== 1 || message.minProtocolVersion !== 1
      || message.deviceId !== this.identity.deviceId || message.sessionId !== this.sessionId
      || !Number.isSafeInteger(message.sequence) || message.sequence < this.lastAckSequence || message.sequence >= this.sequence) {
      throw new Error('invalid_heartbeat_ack');
    }
    this.lastAckSequence = message.sequence;
    this.lastAckAt = this.now();
    this.emit('heartbeatAck', message.sequence);
  }

  async #operationRequest(socket, message) {
    exactGatewayMessage(message, ['type', 'sessionId', 'request']);
    if (message.type !== 'operation_request' || message.sessionId !== this.sessionId || this.state !== 'online') {
      throw new Error('operation_request_session_mismatch');
    }
    const request = validateOperationRequest(message.request);
    if (request.deviceId !== this.identity.deviceId) throw new Error('operation_request_device_mismatch');
    const definition = operationDefinition(request.operation);
    const advertised = this.capabilities.some((capability) => capability.operation === request.operation
      && capability.authority === definition.authority && capability.operationVersion === definition.operationVersion);
    if (!this.allowedAuthorities.has(definition.authority) || !advertised) throw new Error('operation_request_not_advertised');
    if (typeof this.operationHandler !== 'function') throw new Error('operation_handler_unavailable');
    let result;
    try {
      result = await this.operationHandler(request);
    } catch {
      result = {
        ...protocolEnvelope(), requestId: request.requestId, deviceId: request.deviceId, operation: request.operation,
        ok: false, completedAt: new Date(this.now()).toISOString(),
        error: commanderError({ category: 'internal', code: definition.authority === 'read' ? 'READ_HANDLER_FAILED' : 'EXECUTION_HANDLER_FAILED', message: 'Commander operation handler failed.', retryable: false }),
      };
    }
    result = validateOperationResult(result);
    if (result.requestId !== request.requestId || result.deviceId !== request.deviceId || result.operation !== request.operation) {
      throw new Error('operation_result_identity_mismatch');
    }
    socket.write(encodeJsonLine({ ...protocolEnvelope(), type: 'operation_result', sessionId: this.sessionId, result }));
  }


  #sendExecutionEvent(event) {
    if (!this.socket || this.socket.destroyed || this.state !== 'online' || !this.sessionId) return false;
    try {
      this.socket.write(encodeJsonLine({ ...protocolEnvelope(), type: 'execution_event', sessionId: this.sessionId, event }));
      return true;
    } catch { return false; }
  }

  #scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    const attempt = this.reconnectAttempt++;
    const delay = reconnectDelayMs(attempt, this.reconnectPolicy);
    log(this.logger, 'info', 'commander_agent_reconnect_scheduled', { deviceId: this.identity.deviceId, attempt, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delay);
  }
}
