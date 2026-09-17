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

test('ssh-gateway transport is bounded and uses remote test aliases', () => {
  const remote = {
    id: 'remote-demo',
    enabled: true,
    transport: {
      type: 'ssh-gateway',
      host: 'nexolab-edge-01',
      user: 'nexolab',
      identityFile: '/home/btcradar/.ssh/autopilot-v3-nexolab',
    },
    tests: { required: { remote: true, timeoutMs: 1000 } },
    steps: [
      { id: 'inspect', action: 'repo.inspect' },
      { id: 'test', action: 'repo.test', params: { alias: 'required' } },
    ],
  };
  assert.equal(validateConfig({ version: 3, projects: [remote] }).projects[0], remote);
  assert.throws(() => validateConfig({ version: 3, projects: [{
    ...remote, transport: { ...remote.transport, identityFile: '../bad' },
  }] }), /invalid_ssh_identity/);
  assert.throws(() => validateConfig({ version: 3, projects: [{
    ...remote, tests: { required: { command: 'python3', args: [] } },
  }] }), /invalid_remote_test/);
});

test('Commander integration is additive, explicit per project and preserves fallback config', () => {
  const commanderProject = {
    ...validProject,
    commander: {
      enabled: true,
      deviceId: 'demo-device',
      repoPath: '/srv/demo',
      testAliases: { required: 'v3-required' },
    },
  };
  assert.equal(validateConfig({ version: 3, projects: [commanderProject] }).projects[0], commanderProject);
  assert.throws(() => validateConfig({ version: 3, projects: [{
    ...commanderProject,
    commander: { ...commanderProject.commander, repoPath: '../unsafe' },
  }] }), /invalid_commander_repo_path/);
  assert.throws(() => validateConfig({ version: 3, projects: [{
    ...commanderProject,
    commander: { ...commanderProject.commander, testAliases: {} },
  }] }), /missing_commander_test_alias/);
  assert.equal(validateConfig(valid), valid);
});


test('coding.run requires an explicit bounded shadow coding configuration', () => {
  const codingProject = {
    id: 'nexo-coding', enabled: true,
    transport: {
      type: 'ssh-gateway', host: 'nexolab-edge-01', user: 'nexolab',
      identityFile: '/home/btcradar/.ssh/autopilot-v3-nexolab',
    },
    github: { repository: 'eNgine9r/nexolab-platform', taskLabels: ['autopilot'] },
    tests: { required: { remote: true, timeoutMs: 1000 } },
    coding: {
      enabled: true, mode: 'shadow', timeoutMs: 900000,
      approvalPolicy: 'on-request', networkAccess: false, effort: 'low',
      instructions: 'Implement only the scoped issue in the isolated worktree.',
      codexTransport: {
        type: 'ssh', host: 'nexolab-edge-01', user: 'nexolab',
        identityFile: '/home/btcradar/.ssh/autopilot-nexolab',
      },
    },
    steps: [{ id: 'coding', action: 'coding.run' }],
  };
  assert.equal(validateConfig({ version: 3, projects: [codingProject] }).projects[0], codingProject);
  assert.throws(() => validateConfig({ version: 3, projects: [{
    ...codingProject, coding: { ...codingProject.coding, enabled: false },
  }] }), /coding_not_enabled/);
  assert.throws(() => validateConfig({ version: 3, projects: [{
    ...codingProject, coding: { ...codingProject.coding, networkAccess: true },
  }] }), /invalid_coding_network_access/);
  assert.throws(() => validateConfig({ version: 3, projects: [{
    ...codingProject, steps: [{ id: 'coding', action: 'coding.run', params: { prompt: 'arbitrary' } }],
  }] }), /coding_params_not_allowed/);
});