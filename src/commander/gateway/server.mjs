import crypto from 'node:crypto';
import net from 'node:net';
import { protocolEnvelope, validateDevice } from '../contracts/index.mjs';
import { createChallenge, verifyRegistrationProof } from '../session/auth.mjs';
import { encodeJsonLine, JsonLineDecoder } from '../session/framing.mjs';
import { assertPhase2GatewayHost } from '../config.mjs';
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

export class CommanderGatewayServer {
  constructor(options = {}) {
    if (typeof options.secretResolver !== 'function') throw new Error('secret_resolver_required');
    this.host = assertPhase2GatewayHost(options.host ?? '127.0.0.1');
    this.port = Number(options.port ?? 0);
    this.secretResolver = options.secretResolver;
    this.registry = options.registry ?? new CommanderDeviceRegistry({ heartbeatTimeoutMs: options.heartbeatTimeoutMs });
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? crypto.randomBytes;
    this.heartbeatIntervalMs = Number(options.heartbeatIntervalMs ?? 5_000);
    this.heartbeatTimeoutMs = Number(options.heartbeatTimeoutMs ?? 20_000);
    this.authTimeoutMs = Number(options.authTimeoutMs ?? 10_000);
    this.server = null;
    this.sockets = new Set();
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
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
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
      if (state.deviceId && state.sessionId) this.registry.disconnect(state.deviceId, state.sessionId);
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
