import test from 'node:test';
import assert from 'node:assert/strict';
import { transition } from '../src/v3/state-machine.mjs';

const project = {
  id: 'demo',
  steps: [
    { id: 'inspect', action: 'repo.inspect' },
    { id: 'test', action: 'repo.test' },
    { id: 'review', action: 'operator.review', approval: 'user' },
  ],
};

test('deterministic happy path reaches approval then completion', () => {
  let r = transition(project, null, { id: 'e1', kind: 'task.received', taskId: 't1' }, 1);
  assert.equal(r.state.status, 'ready');
  r = transition(project, r.state, { id: 'e2', kind: 'action.started', stepId: 'inspect' }, 2);
  r = transition(project, r.state, { id: 'e3', kind: 'action.succeeded', stepId: 'inspect', evidence: 'ok' }, 3);
  assert.equal(r.state.status, 'ready');
  assert.equal(r.state.stepIndex, 1);
  r = transition(project, r.state, { id: 'e4', kind: 'action.started', stepId: 'test' }, 4);
  r = transition(project, r.state, { id: 'e5', kind: 'action.succeeded', stepId: 'test' }, 5);
  assert.equal(r.state.status, 'waiting_approval');
  assert.equal(r.state.stepIndex, 2);
});

test('approval is explicit and cannot be bypassed', () => {
  let r = transition(project, null, { id: 'a1', kind: 'task.received' });
  r = transition(project, r.state, { id: 'a2', kind: 'action.started', stepId: 'inspect' });
  r = transition(project, r.state, { id: 'a3', kind: 'action.succeeded', stepId: 'inspect' });
  r = transition(project, r.state, { id: 'a4', kind: 'action.started', stepId: 'test' });
  r = transition(project, r.state, { id: 'a5', kind: 'action.succeeded', stepId: 'test' });
  assert.throws(() => transition(project, r.state, { kind: 'action.started', stepId: 'review' }), /cannot_start/);
  r = transition(project, r.state, { id: 'a6', kind: 'approval.granted', stepId: 'review' });
  assert.equal(r.state.status, 'ready');
});

test('failure blocks until deterministic retry', () => {
  let r = transition(project, null, { id: 'f1', kind: 'task.received' });
  r = transition(project, r.state, { id: 'f2', kind: 'action.started', stepId: 'inspect' });
  r = transition(project, r.state, { id: 'f3', kind: 'action.failed', stepId: 'inspect', error: 'boom' });
  assert.equal(r.state.status, 'blocked');
  assert.equal(r.state.lastError, 'boom');
  r = transition(project, r.state, { id: 'f4', kind: 'retry' });
  assert.equal(r.state.status, 'ready');
});

test('duplicate event id is idempotent', () => {
  const first = transition(project, null, { id: 'dup', kind: 'task.received' }, 10);
  const second = transition(project, first.state, { id: 'dup', kind: 'task.received' }, 20);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.state, first.state);
});
