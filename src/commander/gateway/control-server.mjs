import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { encodeJsonLine, JsonLineDecoder } from '../session/framing.mjs';
import {
  COMMANDER_CONTROL_MAX_FRAME_BYTES,
  commanderErrorFromControlFailure,
  controlFailure,
  controlSuccess,
  validateControlRequest,
} from '../control-protocol.mjs';

function safeDeviceEntry(gateway, entry) {
  if (!entry) return null;
  return {
    device: {
      ...entry.device,
      capabilities: entry.device.capabilities.filter((capability) => gateway.allowedAuthorities.has(capability.authority)),
    },
    status: entry.status,
    connectedAt: new Date(entry.connectedAt).toISOString(),
    lastHeartbeatAt: new Date(entry.lastHeartbeatAt).toISOString(),
  };
}

function socketAcceptsConnections(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    const finish = (error, active) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(active);
    };
    socket.once('connect', () => finish(null, true));
    socket.once('error', (error) => {
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT') finish(null, false);
      else finish(error);
    });
  });
}

async function prepareSocket(socketPath) {
  const parent = path.dirname(socketPath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.chmod(parent, 0o700);
  try {
    const stat = await fs.lstat(socketPath);
    if (!stat.isSocket()) throw new Error('control_socket_path_not_socket');
    if (await socketAcceptsConnections(socketPath)) throw new Error('control_socket_in_use');
    await fs.unlink(socketPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export class CommanderControlServer {
  constructor({ gateway, socketPath, logger = console } = {}) {
    if (!gateway?.registry || typeof gateway.request !== 'function') throw new Error('control_gateway_required');
    if (!path.isAbsolute(String(socketPath || ''))) throw new Error('control_socket_must_be_absolute');
    this.gateway = gateway;
    this.socketPath = socketPath;
    this.logger = logger;
    this.server = null;
    this.connections = new Set();
  }

  async start() {
    if (this.server) throw new Error('control_server_already_started');
    await prepareSocket(this.socketPath);
    const server = net.createServer((socket) => this.#accept(socket));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => { server.off('error', reject); resolve(); });
    });
    await fs.chmod(this.socketPath, 0o600);
    this.server = server;
    return this.socketPath;
  }

  async stop() {
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    try { await fs.unlink(this.socketPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }

  async #dispatch(request) {
    if (request.method === 'device.list') {
      return { devices: this.gateway.registry.list().map((entry) => safeDeviceEntry(this.gateway, entry)) };
    }
    if (request.method === 'device.get') {
      const entry = safeDeviceEntry(this.gateway, this.gateway.registry.get(request.params.deviceId));
      if (!entry) throw new Error('device_not_found');
      return entry;
    }
    if (request.method === 'operation.request') {
      return this.gateway.request(request.params.request, { timeoutMs: request.params.timeoutMs });
    }
    throw new Error('unsupported_control_method');
  }

  #accept(socket) {
    this.connections.add(socket);
    const decoder = new JsonLineDecoder({ maxFrameBytes: COMMANDER_CONTROL_MAX_FRAME_BYTES });
    let queue = Promise.resolve();
    socket.on('data', (chunk) => {
      let messages;
      try { messages = decoder.push(chunk); } catch { socket.destroy(); return; }
      for (const message of messages) {
        queue = queue.then(async () => {
          let request;
          try {
            request = validateControlRequest(message);
            const result = await this.#dispatch(request);
            socket.write(encodeJsonLine(controlSuccess(request.requestId, result), { maxFrameBytes: COMMANDER_CONTROL_MAX_FRAME_BYTES }));
          } catch (error) {
            const requestId = typeof message?.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(message.requestId)
              ? message.requestId : 'invalid-request';
            socket.write(encodeJsonLine(controlFailure(requestId, commanderErrorFromControlFailure(error)), { maxFrameBytes: COMMANDER_CONTROL_MAX_FRAME_BYTES }));
          }
        }).catch(() => socket.destroy());
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.connections.delete(socket));
  }
}
