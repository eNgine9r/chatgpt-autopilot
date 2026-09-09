import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { CommanderExecutionEngine } from '../src/commander/agent/execution-engine.mjs';
import { validateExecutionPolicy } from '../src/commander/agent/execution-policy.mjs';
import { protocolEnvelope } from '../src/commander/contracts/index.mjs';

function policy(commands, maxConcurrent = 2) {
  return validateExecutionPolicy({ version: 1, maxConcurrent, commands });
}
function cmd(code, { timeoutMs = 1000, allowStdin = false } = {}) {
  return { executable: process.execPath, args: ['-e', code], cwd: process.cwd(), timeoutMs, allowStdin };
}
function req(requestId, operation, params, idempotencyKey) {
  return { ...protocolEnvelope(), requestId, deviceId: 'dev-exec', operation, params, ...(idempotencyKey ? { idempotencyKey } : {}) };
}
async function started(engine, alias, key = 'key-start') {
  const result = await engine.handle(req(`request-${key}`, 'execution.start', { alias }, key));
  assert.equal(result.ok, true);
  return result.data.execution.executionId;
}

test('execution lifecycle streams bounded stdout/stderr and completes successfully', async (t) => {
  const engine = new CommanderExecutionEngine({ deviceId: 'dev-exec', policy: policy({ probe: cmd("console.log('hello');console.error('warn')") }) });
  t.after(() => engine.shutdown());
  const events = []; engine.on('event', (event) => events.push(event));
  const id = await started(engine, 'probe');
  const terminal = await engine.waitForTerminal(id);
  assert.equal(terminal.state, 'success');
  assert.equal(terminal.exitCode, 0);
  const output = await engine.handle(req('read-output', 'execution.output', { executionId: id }));
  assert.equal(output.ok, true);
  assert.match(output.data.events.filter((e) => e.type === 'stdout').map((e) => e.payload.chunk).join(''), /hello/);
  assert.match(output.data.events.filter((e) => e.type === 'stderr').map((e) => e.payload.chunk).join(''), /warn/);
  assert.equal(events.at(-1).type, 'result');
});

test('execution output is bounded and reports truncation', async (t) => {
  const engine = new CommanderExecutionEngine({ deviceId: 'dev-exec', policy: policy({ loud: cmd("process.stdout.write('x'.repeat(10000))") }), maxOutputBytes: 1024 });
  t.after(() => engine.shutdown());
  const id = await started(engine, 'loud', 'loud-key');
  await engine.waitForTerminal(id);
  const output = await engine.handle(req('loud-output', 'execution.output', { executionId: id }));
  const kept = output.data.events.filter((e) => e.type === 'stdout').reduce((n, e) => n + Buffer.byteLength(e.payload.chunk), 0);
  assert.ok(kept <= 1024);
  assert.ok(output.data.totalBytes >= 10000);
  assert.equal(output.data.truncated, true);
});

test('stdin is gated per alias and duplicate input is idempotent', async (t) => {
  const engine = new CommanderExecutionEngine({ deviceId: 'dev-exec', policy: policy({ echo: cmd("process.stdin.once('data',d=>{process.stdout.write(d);process.exit(0)})", { allowStdin: true, timeoutMs: 2000 }) }) });
  t.after(() => engine.shutdown());
  const id = await started(engine, 'echo', 'echo-start');
  const first = await engine.handle(req('input-one', 'execution.input', { executionId: id, data: 'abc' }, 'input-key'));
  const replay = await engine.handle(req('input-two', 'execution.input', { executionId: id, data: 'abc' }, 'input-key'));
  assert.equal(first.ok, true); assert.equal(replay.ok, true); assert.equal(replay.requestId, 'input-two');
  await engine.waitForTerminal(id);
  const output = await engine.handle(req('echo-output', 'execution.output', { executionId: id }));
  assert.equal(output.data.events.filter((e) => e.type === 'stdout').map((e) => e.payload.chunk).join(''), 'abc');
  await assert.rejects(() => engine.handle(req('input-three', 'execution.input', { executionId: id, data: 'different' }, 'input-key')), /idempotency_key_conflict/);
});

test('timeout and cancel terminate owned executions', async (t) => {
  const engine = new CommanderExecutionEngine({ deviceId: 'dev-exec', policy: policy({ timeout: cmd('setInterval(()=>{},1000)', { timeoutMs: 120 }), cancel: cmd('setInterval(()=>{},1000)', { timeoutMs: 5000 }) }), killGraceMs: 50 });
  t.after(() => engine.shutdown());
  const timeoutId = await started(engine, 'timeout', 'timeout-start');
  assert.equal((await engine.waitForTerminal(timeoutId, 2000)).state, 'timeout');
  const cancelId = await started(engine, 'cancel', 'cancel-start');
  const cancelled = await engine.handle(req('cancel-request', 'execution.cancel', { executionId: cancelId }, 'cancel-key'));
  assert.equal(cancelled.ok, true);
  assert.equal((await engine.waitForTerminal(cancelId, 2000)).state, 'cancelled');
});

test('start idempotency survives a new transport request id without duplicate process', async (t) => {
  const engine = new CommanderExecutionEngine({ deviceId: 'dev-exec', policy: policy({ slow: cmd("setTimeout(()=>process.exit(0),250)") }) });
  t.after(() => engine.shutdown());
  const first = await engine.handle(req('transport-one', 'execution.start', { alias: 'slow' }, 'same-start'));
  const second = await engine.handle(req('transport-two', 'execution.start', { alias: 'slow' }, 'same-start'));
  assert.equal(second.requestId, 'transport-two');
  assert.equal(second.data.execution.executionId, first.data.execution.executionId);
  assert.equal(engine.executions.size, 1);
  await engine.waitForTerminal(first.data.execution.executionId);
  await assert.rejects(() => engine.handle(req('transport-three', 'execution.start', { alias: 'other' }, 'same-start')), /idempotency_key_conflict/);
});

test('concurrency limit fails closed without spawning another execution', async (t) => {
  const engine = new CommanderExecutionEngine({ deviceId: 'dev-exec', policy: policy({ hold: cmd('setInterval(()=>{},1000)', { timeoutMs: 5000 }) }, 1) });
  t.after(() => engine.shutdown());
  const id = await started(engine, 'hold', 'hold-one');
  const denied = await engine.handle(req('hold-two-request', 'execution.start', { alias: 'hold' }, 'hold-two'));
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'EXECUTION_CONCURRENCY_LIMIT');
  await engine.handle(req('hold-cancel', 'execution.cancel', { executionId: id }, 'hold-cancel-key'));
  await engine.waitForTerminal(id);
});


test('cancel terminates the owned descendant process group', async (t) => {
  const code = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`;
  const engine = new CommanderExecutionEngine({ deviceId: 'dev-exec', policy: policy({ tree: cmd(code, { timeoutMs: 5000 }) }), killGraceMs: 80 });
  let descendantPid = null;
  t.after(async () => {
    await engine.shutdown();
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch {} }
  });
  const id = await started(engine, 'tree', 'tree-start');
  descendantPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('descendant_pid_timeout')), 1500);
    const listener = (event) => {
      if (event.executionId !== id || event.type !== 'stdout') return;
      const pid = Number(String(event.payload.chunk).trim());
      if (!Number.isInteger(pid) || pid <= 1) return;
      clearTimeout(timer); engine.off('event', listener); resolve(pid);
    };
    engine.on('event', listener);
  });
  assert.doesNotThrow(() => process.kill(descendantPid, 0));
  await engine.handle(req('tree-cancel', 'execution.cancel', { executionId: id }, 'tree-cancel-key'));
  assert.equal((await engine.waitForTerminal(id, 2000)).state, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
  descendantPid = null;
});


test('spawn boundary is shell-free and environment is sanitized', async () => {
  let captured = null;
  const fakeChild = new (await import('node:events')).EventEmitter();
  fakeChild.pid = 424242;
  fakeChild.stdout = new (await import('node:stream')).PassThrough();
  fakeChild.stderr = new (await import('node:stream')).PassThrough();
  fakeChild.stdin = new (await import('node:stream')).PassThrough();
  const spawnImpl = (executable, args, options) => {
    captured = { executable, args, options };
    queueMicrotask(() => fakeChild.emit('exit', 0));
    return fakeChild;
  };
  const engine = new CommanderExecutionEngine({ deviceId: 'dev-exec', policy: policy({ safe: cmd("console.log('unused')") }), spawnImpl });
  const id = await started(engine, 'safe', 'safe-spawn');
  await engine.waitForTerminal(id);
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.detached, true);
  assert.deepEqual(captured.options.env, { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
  assert.equal(Object.hasOwn(captured.options.env, 'HOME'), false);
  await engine.shutdown();
});
