export class CommanderDeviceRegistry {
  constructor({ heartbeatTimeoutMs = 30_000, now = Date.now, maxDevices = 128 } = {}) {
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.now = now;
    this.maxDevices = maxDevices;
    this.devices = new Map();
  }

  register(device, sessionId, connection) {
    const previous = this.devices.get(device.deviceId);
    if (!previous && this.devices.size >= this.maxDevices) throw new Error('device_registry_full');
    const entry = {
      device,
      sessionId,
      connection,
      status: 'online',
      connectedAt: this.now(),
      lastHeartbeatAt: this.now(),
      heartbeatSequence: -1,
    };
    this.devices.set(device.deviceId, entry);
    return { entry, previous };
  }

  heartbeat(deviceId, sessionId, sequence) {
    const entry = this.devices.get(deviceId);
    if (!entry || entry.sessionId !== sessionId) throw new Error('stale_or_unknown_session');
    if (!Number.isSafeInteger(sequence) || sequence <= entry.heartbeatSequence) throw new Error('stale_heartbeat_sequence');
    entry.heartbeatSequence = sequence;
    entry.lastHeartbeatAt = this.now();
    entry.status = 'online';
    return entry;
  }

  disconnect(deviceId, sessionId) {
    const entry = this.devices.get(deviceId);
    if (!entry || entry.sessionId !== sessionId) return false;
    entry.status = 'offline';
    entry.connection = null;
    return true;
  }

  expireStale() {
    const cutoff = this.now() - this.heartbeatTimeoutMs;
    const expired = [];
    for (const entry of this.devices.values()) {
      if (entry.status === 'online' && entry.lastHeartbeatAt < cutoff) {
        entry.status = 'offline';
        entry.connection = null;
        expired.push(entry.device.deviceId);
      }
    }
    return expired;
  }

  get(deviceId) { return this.devices.get(deviceId) ?? null; }
  list() { return [...this.devices.values()].map(({ connection, ...entry }) => ({ ...entry })); }
}
