import fs from 'node:fs/promises';
import path from 'node:path';

const APPROVALS = new Set(['none', 'user']);
export const ALLOWED_ACTIONS = new Set(['repo.inspect', 'repo.test', 'operator.review', 'coding.run']);
export const ALLOWED_TEST_COMMANDS = new Set([
  'npm', 'node', 'python3', 'pytest', 'uv', 'pnpm', 'yarn', 'cargo', 'go', 'make',
]);

function isRemote(project) {
  return project.transport?.type === 'ssh-gateway';
}

function validateTransport(project) {
  if (project.transport == null) return;
  const t = project.transport;
  if (!t || typeof t !== 'object' || t.type !== 'ssh-gateway') throw new Error(`invalid_transport:${project.id}`);
  if (!/^[A-Za-z0-9._-]{1,253}$/.test(String(t.host ?? ''))) throw new Error(`invalid_ssh_host:${project.id}`);
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(String(t.user ?? ''))) throw new Error(`invalid_ssh_user:${project.id}`);
  if (!path.isAbsolute(String(t.identityFile ?? ''))) throw new Error(`invalid_ssh_identity:${project.id}`);
  const port = Number(t.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid_ssh_port:${project.id}`);
}

function validateTests(project) {
  const tests = project.tests ?? {};
  if (!tests || typeof tests !== 'object' || Array.isArray(tests)) throw new Error(`invalid_tests:${project.id}`);
  for (const [alias, spec] of Object.entries(tests)) {
    if (!/^[A-Za-z0-9._-]+$/.test(alias) || !spec || typeof spec !== 'object') throw new Error(`invalid_test:${project.id}`);
    const timeout = Number(spec.timeoutMs ?? 600000);
    if (!Number.isFinite(timeout) || timeout < 100 || timeout > 1800000) throw new Error(`invalid_test_timeout:${project.id}:${alias}`);
    if (isRemote(project)) {
      if (spec.remote !== true) throw new Error(`invalid_remote_test:${project.id}:${alias}`);
      continue;
    }
    if (!ALLOWED_TEST_COMMANDS.has(spec.command)) throw new Error(`test_command_not_allowed:${project.id}:${alias}`);
    if (!Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new Error(`invalid_test_args:${project.id}:${alias}`);
    }
  }
}


const COMMANDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validateCommander(project) {
  if (project.commander == null) return;
  const c = project.commander;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`invalid_commander:${project.id}`);
  const allowed = new Set(['enabled', 'deviceId', 'repoPath', 'testAliases']);
  for (const key of ['enabled', 'deviceId', 'repoPath', 'testAliases']) {
    if (!Object.hasOwn(c, key)) throw new Error(`missing_commander_field:${project.id}:${key}`);
  }
  for (const key of Object.keys(c)) if (!allowed.has(key)) throw new Error(`unknown_commander_field:${project.id}:${key}`);
  if (typeof c.enabled !== 'boolean') throw new Error(`invalid_commander_enabled:${project.id}`);
  if (!COMMANDER_ID.test(String(c.deviceId ?? ''))) throw new Error(`invalid_commander_device:${project.id}`);
  if (!path.isAbsolute(String(c.repoPath ?? ''))) throw new Error(`invalid_commander_repo_path:${project.id}`);
  if (!c.testAliases || typeof c.testAliases !== 'object' || Array.isArray(c.testAliases)) throw new Error(`invalid_commander_test_aliases:${project.id}`);
  const entries = Object.entries(c.testAliases);
  if (entries.length > 64) throw new Error(`too_many_commander_test_aliases:${project.id}`);
  for (const [alias, commanderAlias] of entries) {
    if (!Object.hasOwn(project.tests ?? {}, alias)) throw new Error(`unknown_commander_test_alias:${project.id}:${alias}`);
    if (!COMMANDER_ID.test(String(commanderAlias ?? ''))) throw new Error(`invalid_commander_test_alias:${project.id}:${alias}`);
  }
}

const CODING_EFFORT = new Set(['low', 'medium', 'high']);

function validateCoding(project) {
  if (project.coding == null) return;
  const c = project.coding;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`invalid_coding:${project.id}`);
  const allowed = new Set([
    'enabled', 'mode', 'instructions', 'timeoutMs', 'approvalPolicy',
    'networkAccess', 'effort', 'model', 'codexTransport',
  ]);
  for (const key of Object.keys(c)) if (!allowed.has(key)) throw new Error(`unknown_coding_field:${project.id}:${key}`);
  if (typeof c.enabled !== 'boolean') throw new Error(`invalid_coding_enabled:${project.id}`);
  if (c.mode !== 'shadow') throw new Error(`invalid_coding_mode:${project.id}`);
  if (typeof c.instructions !== 'string' || !c.instructions.trim() || c.instructions.length > 8000) {
    throw new Error(`invalid_coding_instructions:${project.id}`);
  }
  const timeout = Number(c.timeoutMs ?? 900000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 1800000) throw new Error(`invalid_coding_timeout:${project.id}`);
  if ((c.approvalPolicy ?? 'on-request') !== 'on-request') throw new Error(`invalid_coding_approval_policy:${project.id}`);
  if (c.networkAccess !== false) throw new Error(`invalid_coding_network_access:${project.id}`);
  if (c.effort != null && !CODING_EFFORT.has(String(c.effort))) throw new Error(`invalid_coding_effort:${project.id}`);
  if (c.model != null && (typeof c.model !== 'string' || c.model.length > 120)) throw new Error(`invalid_coding_model:${project.id}`);
  const t = c.codexTransport;
  if (!t || typeof t !== 'object' || Array.isArray(t) || t.type !== 'ssh') throw new Error(`invalid_coding_transport:${project.id}`);
  if (!/^[A-Za-z0-9._-]{1,253}$/.test(String(t.host ?? ''))) throw new Error(`invalid_coding_host:${project.id}`);
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(String(t.user ?? ''))) throw new Error(`invalid_coding_user:${project.id}`);
  if (!path.isAbsolute(String(t.identityFile ?? ''))) throw new Error(`invalid_coding_identity:${project.id}`);
  if (project.transport?.type !== 'ssh-gateway') throw new Error(`coding_requires_ssh_gateway:${project.id}`);
  if (!project.github?.repository) throw new Error(`coding_requires_github:${project.id}`);
}

function validateGitHub(project, repositories) {
  if (project.github == null) return;
  if (!project.github || typeof project.github !== 'object') throw new Error(`invalid_github:${project.id}`);
  const repository = String(project.github.repository ?? '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`invalid_github_repository:${project.id}`);
  if (repositories.has(repository)) throw new Error(`duplicate_repo:${repository}`);
  repositories.add(repository);
  const labels = project.github.taskLabels;
  if (!Array.isArray(labels) || labels.length < 1 || labels.length > 8) throw new Error(`invalid_labels:${project.id}`);
  const unique = new Set();
  for (const label of labels) {
    if (typeof label !== 'string' || label.length < 1 || label.length > 50 || unique.has(label)) throw new Error(`invalid_labels:${project.id}`);
    unique.add(label);
  }
}

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || value.version !== 3 || !Array.isArray(value.projects)) {
    throw new Error('invalid_v3_config');
  }
  const ids = new Set();
  const repositories = new Set();
  for (const project of value.projects) {
    if (!project || typeof project !== 'object' || !project.id || ids.has(project.id)) {
      throw new Error('invalid_project_id');
    }
    ids.add(project.id);
    if (!Array.isArray(project.steps) || project.steps.length === 0) throw new Error(`missing_steps:${project.id}`);
    validateTransport(project);
    validateTests(project);
    validateCommander(project);
    validateGitHub(project, repositories);
    validateCoding(project);

    const stepIds = new Set();
    for (const step of project.steps) {
      if (!step?.id || !step?.action || stepIds.has(step.id)) throw new Error(`invalid_step:${project.id}`);
      stepIds.add(step.id);
      if (!ALLOWED_ACTIONS.has(step.action)) throw new Error(`unsupported_action:${project.id}:${step.id}`);
      const approval = step.approval ?? 'none';
      if (!APPROVALS.has(approval)) throw new Error(`invalid_approval:${project.id}:${step.id}`);
      if (step.action.startsWith('repo.') && !isRemote(project) && (!project.repoPath || !path.isAbsolute(project.repoPath))) {
        throw new Error(`invalid_repo_path:${project.id}`);
      }
      if (step.action === 'repo.test') {
        const alias = step.params?.alias;
        if (typeof alias !== 'string' || !project.tests?.[alias]) {
          throw new Error(`unknown_test_alias:${project.id}:${step.id}`);
        }
        if (project.commander?.enabled === true && !project.commander.testAliases?.[alias]) {
          throw new Error(`missing_commander_test_alias:${project.id}:${step.id}`);
        }
      }
      if (step.action === 'coding.run') {
        if (project.coding?.enabled !== true || project.coding?.mode !== 'shadow') {
          throw new Error(`coding_not_enabled:${project.id}:${step.id}`);
        }
        const params = step.params ?? {};
        if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length > 0) {
          throw new Error(`coding_params_not_allowed:${project.id}:${step.id}`);
        }
      }
    }
  }
  return value;
}

export async function loadConfig(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return validateConfig(JSON.parse(raw));
}

export function projectById(config, id) {
  const project = config.projects.find((item) => item.id === id && item.enabled !== false);
  if (!project) throw new Error(`unknown_or_disabled_project:${id}`);
  return project;
}
