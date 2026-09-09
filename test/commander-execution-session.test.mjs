import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { CommanderAgentClient } from '../src/commander/agent/client.mjs';
import { CommanderExecutionEngine } from '../src/commander/agent/execution-engine.mjs';
import { phase4ExecutionCapabilities, validateExecutionPolicy } from '../src/commander/agent/execution-policy.mjs';
import { CommanderGatewayServer } from '../src/commander/gateway/server.mjs';
import { protocolEnvelope } from '../src/commander/contracts/index.mjs';

const secret = 'phase-four-session-secret-material-123456789';
const identity = { version: 1, deviceId: 'phase4-session-device', createdAt: new Date().toISOString() };
const logger = { info() {}, warn() {}, error() {} };

function request(requestId, operation, params, idempotencyKey) {
  return { ...protocolEnvelope(), requestId, deviceId: identity.deviceId, operation, params, ...(idempotencyKey ? { idempotencyKey } : {}) };
}
function waitState(agent, wanted, timeoutMs = 3000) {
  if (agent.state === wanted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`state_timeout:${wanted}:${agent.state}`)), timeoutMs);
    const listener = (state) => { if (state === wanted) { clearTimeout(timer); agent.off('state', listener); resolve(); } };
    agent.on('state', listener);
  });
}
function makeEngine() {
  const policy = validateExecutionPolicy({ version: 1, maxConcurrent: 2, commands: {
    stream: { executable: process.execPath, args: ['-e', "console.log('streamed');setTimeout(()=>process.exit(0),100)"], cwd: process.cwd(), timeoutMs: 2000, allowStdin: false },
    slow: { executable: process.execPath, args: ['-e', "setTimeout(()=>{console.log('finished-offline');process.exit(0)},700)"], cwd: process.cwd(), timeoutMs: 3000, allowStdin: false },
  } });
  return new CommanderExecutionEngine({ deviceId: identity.deviceId, policy, killGraceMs: 50 });
}

async function setup(t) {
  let gateway = new CommanderGatewayServer({ host: '127.0.0.1', port: 0, secretResolver: async () => secret, logger, heartbeatIntervalMs: 250, heartbeatTimeoutMs: 1200, allowedAuthorities: ['read', 'write'] });
  const address = await gateway.start();
  const engine = makeEngine();
  const agent = new CommanderAgentClient({ gatewayHost: '127.0.0.1', gatewayPort: address.port, identity, secret, logger, capabilities: phase4ExecutionCapabilities(), operationHandler: (r) => engine.handle(r), allowedAuthorities: ['read', 'write'], executionEventSource: engine, reconnectBaseMs: 100, reconnectMaxMs: 200, reconnectJitterRatio: 0 });
  agent.start(); await waitState(agent, 'online');
  t.after(async () => { await engine.shutdown(); await agent.stop(); await gateway.stop(); });
  return { agent, engine, get gateway() { return gateway; }, replaceGateway(next) { gateway = next; }, port: address.port };
}

test('authenticated session streams execution events through Gateway', async (t) => {
  const ctx = await setup(t);
  const streamed = [];
  ctx.gateway.on('executionEvent', (event) => streamed.push(event));
  const start = await ctx.gateway.request(request('stream-start', 'execution.start', { alias: 'stream' }, 'stream-key'));
  const executionId = start.data.execution.executionId;
  assert.equal(start.ok, true);
  assert.equal((await ctx.engine.waitForTerminal(executionId)).state, 'success');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(streamed.some((event) => event.executionId === executionId && event.type === 'stdout' && /streamed/.test(event.payload.chunk)));
  assert.ok(streamed.some((event) => event.executionId === executionId && event.type === 'result'));
});

test('Gateway reconnect and retried start do not duplicate an execution', async (t) => {
  const ctx = await setup(t);
  const first = await ctx.gateway.request(request('slow-start-one', 'execution.start', { alias: 'slow' }, 'slow-idempotency'));
  const executionId = first.data.execution.executionId;
  assert.equal(ctx.engine.executions.size, 1);
  const disconnected = waitState(ctx.agent, 'disconnected');
  await ctx.gateway.stop();
  await disconnected;
  const replacement = new CommanderGatewayServer({ host: '127.0.0.1', port: ctx.port, secretResolver: async () => secret, logger, heartbeatIntervalMs: 250, heartbeatTimeoutMs: 1200, allowedAuthorities: ['read', 'write'] });
  ctx.replaceGateway(replacement);
  await replacement.start();
  await waitState(ctx.agent, 'online', 5000);
  const replay = await replacement.request(request('slow-start-two', 'execution.start', { alias: 'slow' }, 'slow-idempotency'));
  assert.equal(replay.ok, true);
  assert.equal(replay.data.execution.executionId, executionId);
  assert.equal(ctx.engine.executions.size, 1);
  assert.equal((await ctx.engine.waitForTerminal(executionId, 3000)).state, 'success');
  const output = await replacement.request(request('slow-output', 'execution.output', { executionId }));
  assert.match(output.data.events.filter((event) => event.type === 'stdout').map((event) => event.payload.chunk).join(''), /finished-offline/);
});

test('Gateway remains read-only unless execution authority is explicitly enabled', async (t) => {
  const gateway = new CommanderGatewayServer({ host: '127.0.0.1', port: 0, secretResolver: async () => secret, logger });
  const address = await gateway.start();
  const engine = makeEngine();
  const agent = new CommanderAgentClient({ gatewayHost: '127.0.0.1', gatewayPort: address.port, identity, secret, logger, capabilities: phase4ExecutionCapabilities(), operationHandler: (r) => engine.handle(r), allowedAuthorities: ['read', 'write'], executionEventSource: engine });
  agent.start(); await waitState(agent, 'online');
  t.after(async () => { await engine.shutdown(); await agent.stop(); await gateway.stop(); });
  assert.throws(() => gateway.request(request('denied-start', 'execution.start', { alias: 'stream' }, 'denied-key')), /gateway_read_only/);
});
