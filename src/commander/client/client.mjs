import crypto from 'node:crypto';
import net from 'node:net';
import { encodeJsonLine, JsonLineDecoder } from '../session/framing.mjs';
import {
  COMMANDER_CONTROL_MAX_FRAME_BYTES,
  controlRequest,
  validateControlResponse,
} from '../control-protocol.mjs';

export class CommanderPublicClientError extends Error {
  constructor(commanderError) {
    super(commanderError?.message || 'Commander request failed');
    this.name = 'CommanderPublicClientError';
    this.commanderError = commanderError;
    this.code = commanderError?.code;
  }
}

function requestId() {
  return `client-${crypto.randomUUID().replaceAll('-', '')}`;
}

export class CommanderPublicClient {
  constructor({ socketPath, timeoutMs = 10_000, connector } = {}) {
    if (typeof socketPath !== 'string' || !socketPath.startsWith('/')) throw new Error('control_socket_must_be_absolute');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error('invalid_control_client_timeout');
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.connector = connector ?? ((options) => net.createConnection(options));
  }

  listDevices(options = {}) { return this.#call('device.list', {}, options); }
  getDevice(deviceId, options = {}) { return this.#call('device.get', { deviceId }, options); }
  request(request, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    return this.#call('operation.request', { request, timeoutMs }, { ...options, timeoutMs: timeoutMs + 250 });
  }

  #call(method, params, { timeoutMs = this.timeoutMs, signal } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_250) return Promise.reject(new Error('invalid_control_client_timeout'));
    const id = requestId();
    const message = controlRequest({ requestId: id, method, params });
    return new Promise((resolve, reject) => {
      const socket = this.connector({ path: this.socketPath });
      const decoder = new JsonLineDecoder({ maxFrameBytes: COMMANDER_CONTROL_MAX_FRAME_BYTES });
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      const onAbort = () => finish(new Error('control_request_cancelled'));
      const timer = setTimeout(() => finish(new Error('control_request_timeout')), timeoutMs);
      timer.unref?.();
      if (signal?.aborted) { finish(new Error('control_request_cancelled')); return; }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      socket.on('connect', () => {
        try { socket.write(encodeJsonLine(message, { maxFrameBytes: COMMANDER_CONTROL_MAX_FRAME_BYTES })); }
        catch (error) { finish(error); }
      });
      socket.on('data', (chunk) => {
        let messages;
        try { messages = decoder.push(chunk); } catch (error) { finish(error); return; }
        for (const response of messages) {
          try {
            validateControlResponse(response);
            if (response.requestId !== id) throw new Error('control_response_id_mismatch');
            if (!response.ok) { finish(new CommanderPublicClientError(response.error)); return; }
            finish(null, response.result);
          } catch (error) { finish(error); }
        }
      });
      socket.on('error', (error) => finish(error));
      socket.on('close', () => { if (!settled) finish(new Error('control_connection_closed')); });
    });
  }
}
