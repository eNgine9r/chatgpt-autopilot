import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/v3/config.mjs';

const validProject = {
  id: 'demo', enabled: true, repoPath: '/tmp/demo',
  tests: { required: { command: 'node', args: ['--version'], timeoutMs: 1000 } },
  steps: [
    { id: 'inspect', action: 'repo.inspect' },
    { id: 'test', action: 'repo.test', params: { alias: 'required' } },
  ],
};

const valid = { version: 3, projects: [validProject] };

test('v3 config accepts bounded allowlisted deterministic actions', () => {
  assert.equal(validateConfig(valid), valid);
});

test('v3 config rejects duplicate project and step identities', () => {
  assert.throws(() => validateConfig({ version: 3, projects: [validProject, validProject] }), /invalid_project_id/);
  assert.throws(() => validateConfig({ version: 3, projects: [{
    ...validProject,
    steps: [{ id: 'same', action: 'repo.inspect' }, { id: 'same', action: 'repo.inspect' }],
  }] }), /invalid_step/);
});

test('v3 config rejects unsupported actions and unsafe test executables', () => {
  assert.throws(() => validateConfig({ version: 3, projects: [{
    ...validProject, steps: [{ id: 'shell', action: 'shell.exec' }],
  }] }), /unsupported_action/);
  assert.throws(() => validateConfig({ version: 3, projects: [{
    ...validProject, tests: { required: { command: 'bash', args: ['-c', 'echo nope'] } },
  }] }), /test_command_not_allowed/);
});

test('repo.test references only a configured alias', () => {
  assert.throws(() => validateConfig({ version: 3, projects: [{
    ...validProject,
    steps: [{ id: 'test', action: 'repo.test', params: { alias: 'from-event' } }],
  }] }), /unknown_test_alias/);
});

test('repo actions require an absolute private repo path', () => {
  assert.throws(() => validateConfig({ version: 3, projects: [{
    ...validProject, repoPath: '../relative', steps: [{ id: 'inspect', action: 'repo.inspect' }],
  }] }), /invalid_repo_path/);
});

test('GitHub task routing requires unique configured repositories and labels', () => {
  const githubProject = {
    ...validProject,
    github: { repository: 'eNgine9r/demo', taskLabels: ['autopilot'] },
  };
  assert.equal(validateConfig({ version: 3, projects: [githubProject] }).projects[0], githubProject);
  assert.throws(() => validateConfig({ version: 3, projects: [
    githubProject,
    { ...githubProject, id: 'demo-two' },
  ] }), /duplicate_repo/);
  assert.throws(() => validateConfig({ version: 3, projects: [{
    ...githubProject, github: { repository: 'not-a-repository', taskLabels: ['autopilot'] },
  }] }), /invalid_github_repository/);
  assert.throws(() => validateConfig({ version: 3, projects: [{
    ...githubProject, github: { repository: 'eNgine9r/demo', taskLabels: [] },
  }] }), /invalid_labels/);
});