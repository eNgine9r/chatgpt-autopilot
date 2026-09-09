import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommanderAgentClient } from './client.mjs';
import { loadOrCreateDeviceIdentity } from './identity.mjs';
import { CommanderReadOnlyDispatcher } from './readonly-dispatcher.mjs';
import { CommanderExecutionEngine } from './execution-engine.mjs';
import { loadCommanderExecutionPolicy, phase4ExecutionCapabilities } from './execution-policy.mjs';
import { CommanderAgentOperationDispatcher } from './operation-dispatcher.mjs';
import { CommanderControlledWriteDispatcher } from './controlled-write-dispatcher.mjs';
import { loadCommanderWritePolicy, phase5WriteCapabilities } from './write-policy.mjs';
import { loadCommanderReadPolicy, phase3ReadCapabilities } from './read-policy.mjs';
import { commanderEnabled, commanderPort, loadCommanderSecret } from '../config.mjs';

export async function runAgentService(env = process.env) {
  if (!commanderEnabled(env.COMMANDER_ENABLED)) {
    console.info(JSON.stringify({ event: 'commander_agent_disabled' }));
    return null;
  }
  if (commanderEnabled(env.COMMANDER_ADMIN_ENABLED)) throw new Error('commander_admin_not_supported_phase5');
  const home = env.HOME || os.homedir();
  const identityFile = env.COMMANDER_DEVICE_IDENTITY_FILE
    || path.join(home, '.local/state/chatgpt-autopilot-commander/device.json');
  const secretFile = env.COMMANDER_AGENT_SECRET_FILE;
  if (!secretFile) throw new Error('COMMANDER_AGENT_SECRET_FILE_required');
  const identity = await loadOrCreateDeviceIdentity(identityFile, { configuredDeviceId: env.COMMANDER_DEVICE_ID });
  const secret = await loadCommanderSecret(secretFile);
  const readPolicyFile = env.COMMANDER_READ_POLICY_FILE
    || path.join(home, '.config/chatgpt-autopilot-commander/read-policy.json');
  const readPolicy = await loadCommanderReadPolicy(readPolicyFile);
  const readDispatcher = new CommanderReadOnlyDispatcher({ deviceId: identity.deviceId, policy: readPolicy });
  const executionEnabled = commanderEnabled(env.COMMANDER_EXECUTION_ENABLED);
  let executionEngine = null;
  if (executionEnabled) {
    const executionPolicyFile = env.COMMANDER_EXECUTION_POLICY_FILE || path.join(home, '.config/chatgpt-autopilot-commander/execution-policy.json');
    executionEngine = new CommanderExecutionEngine({ deviceId: identity.deviceId, policy: await loadCommanderExecutionPolicy(executionPolicyFile) });
  }
  const writeEnabled = commanderEnabled(env.COMMANDER_WRITE_ENABLED);
  let writeDispatcher = null;
  if (writeEnabled) {
    const writePolicyFile = env.COMMANDER_WRITE_POLICY_FILE || path.join(home, '.config/chatgpt-autopilot-commander/write-policy.json');
    writeDispatcher = new CommanderControlledWriteDispatcher({ deviceId: identity.deviceId, policy: await loadCommanderWritePolicy(writePolicyFile) });
  }
  const dispatcher = new CommanderAgentOperationDispatcher({ readDispatcher, executionEngine, writeDispatcher });
  const capabilities = [...phase3ReadCapabilities(), ...(executionEnabled ? phase4ExecutionCapabilities() : []), ...(writeEnabled ? phase5WriteCapabilities() : [])];
  const client = new CommanderAgentClient({
    gatewayHost: env.COMMANDER_GATEWAY_HOST || '127.0.0.1',
    gatewayPort: commanderPort(env.COMMANDER_GATEWAY_PORT),
    identity,
    secret,
    displayName: env.COMMANDER_DEVICE_NAME || os.hostname(),
    capabilities,
    operationHandler: (request) => dispatcher.handle(request),
    allowedAuthorities: (executionEnabled || writeEnabled) ? ['read', 'write'] : ['read'],
    executionEventSource: executionEngine,
  });
  client.start();
  client.executionEngine = executionEngine;
  client.writeDispatcher = writeDispatcher;
  return client;
}

async function main() {
  const client = await runAgentService();
  if (!client) return;
  const stop = async () => { await client.executionEngine?.shutdown?.(); await client.stop(); process.exitCode = 0; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'commander_agent_fatal', error: String(error.message || error) }));
    process.exitCode = 1;
  });
}
