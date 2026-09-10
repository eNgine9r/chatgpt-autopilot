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

test('same task delivery while active is idempotent but a different task is rejected', () => {
  const first = transition(project, null, {
    id: 'task-a-opened',
    kind: 'task.received',
    task: { id: 'github:demo#42' },
  }, 10);
  const same = transition(project, first.state, {
    id: 'task-a-labeled',
    kind: 'task.received',
    task: { id: 'github:demo#42' },
  }, 20);
  assert.equal(same.duplicate, true);
  assert.deepEqual(same.state, first.state);
  assert.throws(() => transition(project, first.state, {
    id: 'task-b-opened',
    kind: 'task.received',
    task: { id: 'github:demo#43' },
  }, 30), /project_busy:ready/);
});

test('retry preserves Commander attempt after ambiguous failure and advances after known terminal failure', () => {
  let r = transition(project, null, { id: 'r1', kind: 'task.received', taskId: 'task-r' }, 1);
  assert.equal(r.state.attempt, 1);
  r = transition(project, r.state, { id: 'r2', kind: 'action.started', stepId: 'inspect' }, 2);
  r = transition(project, r.state, {
    id: 'r3', kind: 'action.failed', stepId: 'inspect', error: 'commander:transport:COMMANDER_UNAVAILABLE',
    failure: { backend: 'commander', category: 'transport', code: 'COMMANDER_UNAVAILABLE', retryable: true, newAttempt: false },
  }, 3);
  assert.equal(r.state.lastFailure.code, 'COMMANDER_UNAVAILABLE');
  r = transition(project, r.state, { id: 'r4', kind: 'retry' }, 4);
  assert.equal(r.state.attempt, 1);

  r = transition(project, r.state, { id: 'r5', kind: 'action.started', stepId: 'inspect' }, 5);
  r = transition(project, r.state, {
    id: 'r6', kind: 'action.failed', stepId: 'inspect', error: 'commander:execution:EXECUTION_FAILED',
    failure: { backend: 'commander', category: 'execution', code: 'EXECUTION_FAILED', retryable: false, newAttempt: true },
  }, 6);
  r = transition(project, r.state, { id: 'r7', kind: 'retry' }, 7);
  assert.equal(r.state.attempt, 2);
});
