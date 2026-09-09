export const COMMANDER_PROTOCOL = Object.freeze({
  name: 'commander',
  currentVersion: 1,
  minCompatibleVersion: 1,
});

export const COMMANDER_LIMITS = Object.freeze({
  maxIdentifierLength: 128,
  maxMessageBytes: 256 * 1024,
  maxDetailsBytes: 16 * 1024,
  maxOutputBytes: 64 * 1024,
  maxCapabilities: 128,
  maxTimeoutMs: 30 * 60 * 1000,
});

export const COMMANDER_AUTHORITIES = Object.freeze(['read', 'write', 'admin']);
export const COMMANDER_EXECUTION_STATES = Object.freeze([
  'queued', 'running', 'success', 'failed', 'cancelled', 'timeout',
  'requires_approval', 'device_offline',
]);
export const COMMANDER_EVENT_TYPES = Object.freeze(['state', 'stdout', 'stderr', 'result']);
export const COMMANDER_ERROR_CATEGORIES = Object.freeze([
  'validation', 'authentication', 'authorization', 'policy', 'not_found',
  'conflict', 'device_offline', 'timeout', 'cancelled', 'transport',
  'execution', 'version_mismatch', 'internal',
]);

const operationEntries = [
  ['device.health', 'read'],
  ['file.read', 'read'], ['file.list', 'read'], ['file.info', 'read'], ['file.search', 'read'],
  ['process.list', 'read'], ['service.status', 'read'],
  ['git.status', 'read'], ['git.diff', 'read'], ['git.log', 'read'],
  ['execution.get', 'read'], ['execution.output', 'read'],
  ['execution.start', 'write'], ['execution.input', 'write'], ['execution.cancel', 'write'],
  ['file.write', 'write'], ['file.edit', 'write'], ['file.move', 'write'], ['process.terminate', 'write'],
  ['service.start', 'write'], ['service.stop', 'write'], ['service.restart', 'write'],
  ['git.commit', 'write'], ['git.push', 'write'],
  ['system.reboot', 'admin'], ['system.package.install', 'admin'],
];

export const COMMANDER_OPERATIONS = Object.freeze(Object.fromEntries(
  operationEntries.map(([name, authority]) => [name, Object.freeze({
    name,
    authority,
    operationVersion: 1,
    requiresIdempotencyKey: authority !== 'read',
  })]),
));
