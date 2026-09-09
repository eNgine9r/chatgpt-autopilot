import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommanderControlledWriteDispatcher } from '../src/commander/agent/controlled-write-dispatcher.mjs';
import { CommanderWritePolicy } from '../src/commander/agent/write-policy.mjs';
import { protocolEnvelope } from '../src/commander/contracts/index.mjs';

const deviceId = 'phase5-write-device';
function request(requestId, operation, params, idempotencyKey) { return { ...protocolEnvelope(), requestId, deviceId, operation, params, idempotencyKey }; }
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-controlled-write-'));
  const approval = path.join(root, 'approval'); const denied = path.join(root, 'denied');
  await fs.mkdir(approval); await fs.mkdir(denied);
  const policy = await CommanderWritePolicy.create({ version: 1, roots: [
    { path: root, decision: 'allow', maxFileBytes: 65536 },
    { path: approval, decision: 'approval', maxFileBytes: 65536 },
    { path: denied, decision: 'deny', maxFileBytes: 65536 },
  ], services: [], repositories: [] });
  return { root, approval, denied, policy };
}

test('file write/edit/move are atomic, evidenced and idempotent', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const audit = []; const dispatcher = new CommanderControlledWriteDispatcher({ deviceId, policy: f.policy, logger: { info: (event, data) => audit.push([event, data]) } });
  const source = path.join(f.root, 'a.txt');
  const first = await dispatcher.handle(request('w1','file.write',{ path: source, content: 'one', mode: 'create' },'idem-write'));
  assert.equal(first.ok, true); assert.equal(await fs.readFile(source, 'utf8'), 'one'); assert.equal(first.data.evidence.mutated, true);
  const replay = await dispatcher.handle(request('w2','file.write',{ path: source, content: 'one', mode: 'create' },'idem-write'));
  assert.equal(replay.ok, true); assert.equal(replay.requestId, 'w2'); assert.equal(await fs.readFile(source, 'utf8'), 'one');
  const edit = await dispatcher.handle(request('e1','file.edit',{ path: source, oldText: 'one', newText: 'two', expectedReplacements: 1 },'idem-edit'));
  assert.equal(edit.ok, true); assert.equal(edit.data.evidence.replacements, 1); assert.equal(await fs.readFile(source, 'utf8'), 'two');
  const destination = path.join(f.root, 'b.txt');
  const move = await dispatcher.handle(request('m1','file.move',{ source, destination },'idem-move'));
  assert.equal(move.ok, true); assert.equal(await fs.readFile(destination, 'utf8'), 'two'); await assert.rejects(() => fs.stat(source), /ENOENT/);
  assert.ok(audit.some(([, d]) => d.outcome === 'applied')); assert.ok(audit.some(([, d]) => d.outcome === 'replay'));
});

test('approval and deny decisions happen before mutation', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const approvalFile = path.join(f.approval, 'approved.txt');
  const noVerifier = new CommanderControlledWriteDispatcher({ deviceId, policy: f.policy, logger: { info() {} } });
  const pending = await noVerifier.handle(request('a1','file.write',{ path: approvalFile, content: 'x', mode: 'create' },'approval-key'));
  assert.equal(pending.ok, false); assert.equal(pending.error.code, 'REQUIRES_APPROVAL'); await assert.rejects(() => fs.stat(approvalFile), /ENOENT/);
  const approved = new CommanderControlledWriteDispatcher({ deviceId, policy: f.policy, approvalVerifier: async ({ approval }) => approval === 'signed-ok', logger: { info() {} } });
  const applied = await approved.handle(request('a2','file.write',{ path: approvalFile, content: 'x', mode: 'create', approval: 'signed-ok' },'approval-key'));
  assert.equal(applied.ok, true); assert.equal(await fs.readFile(approvalFile,'utf8'),'x');
  const deniedFile = path.join(f.denied, 'no.txt');
  const denied = await approved.handle(request('d1','file.write',{ path: deniedFile, content: 'no', mode: 'create' },'deny-key'));
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'WRITE_POLICY_DENIED'); await assert.rejects(() => fs.stat(deniedFile), /ENOENT/);
});

test('concurrent duplicate idempotency keys execute once and conflicting reuse fails', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  let approvals = 0;
  const dispatcher = new CommanderControlledWriteDispatcher({ deviceId, policy: f.policy, approvalVerifier: async () => { approvals += 1; await new Promise((r) => setTimeout(r, 60)); return true; }, logger: { info() {} } });
  const file = path.join(f.approval, 'race.txt'); const params = { path: file, content: 'once', mode: 'create', approval: 'ok' };
  const [a,b] = await Promise.all([dispatcher.handle(request('r1','file.write',params,'race-key')), dispatcher.handle(request('r2','file.write',params,'race-key'))]);
  assert.equal(a.ok, true); assert.equal(b.ok, true); assert.equal(approvals, 1); assert.equal(await fs.readFile(file,'utf8'),'once');
  await assert.rejects(() => dispatcher.handle(request('r3','file.write',{ ...params, content: 'different' },'race-key')), /idempotency_key_conflict/);
});

test('file edit rejects non-UTF8 and default secret paths', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const dispatcher = new CommanderControlledWriteDispatcher({ deviceId, policy: f.policy, logger: { info() {} } });
  const binary = path.join(f.root,'binary.txt'); await fs.writeFile(binary, Buffer.from([0xff,0xfe,0xfd]));
  const bad = await dispatcher.handle(request('b1','file.edit',{ path: binary, oldText:'x', newText:'y', expectedReplacements:1 },'bad-utf8'));
  assert.equal(bad.ok,false); assert.equal(bad.error.code,'WRITE_EDIT_NOT_UTF8');
  const secret = await dispatcher.handle(request('s1','file.write',{ path:path.join(f.root,'.env'),content:'secret',mode:'create' },'secret-key'));
  assert.equal(secret.ok,false); assert.equal(secret.error.code,'WRITE_POLICY_SECRET_PATH_DENIED');
});
