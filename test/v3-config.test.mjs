import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/v3/config.mjs';

const valid = {
  version: 3,
  projects: [{ id: 'demo', enabled: true, steps: [{ id: 'inspect', action: 'repo.inspect' }] }],
};

test('v3 config accepts a bounded deterministic workflow', () => {
  assert.equal(validateConfig(valid), valid);
});

test('v3 config rejects duplicate project and step identities', () => {
  assert.throws(() => validateConfig({ version: 3, projects: [valid.projects[0], valid.projects[0]] }), /invalid_project_id/);
  assert.throws(() => validateConfig({
    version: 3,
    projects: [{ id: 'demo', steps: [{ id: 'same', action: 'a' }, { id: 'same', action: 'b' }] }],
  }), /invalid_step/);
});

test('v3 config accepts only explicit supported approval modes', () => {
  assert.throws(() => validateConfig({
    version: 3,
    projects: [{ id: 'demo', steps: [{ id: 'x', action: 'a', approval: 'automatic' }] }],
  }), /invalid_approval/);
});
