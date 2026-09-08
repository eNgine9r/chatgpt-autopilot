import fs from 'node:fs/promises';
import path from 'node:path';

const APPROVALS = new Set(['none', 'user']);
export const ALLOWED_ACTIONS = new Set(['repo.inspect', 'repo.test', 'operator.review']);
export const ALLOWED_TEST_COMMANDS = new Set([
  'npm', 'node', 'python3', 'pytest', 'uv', 'pnpm', 'yarn', 'cargo', 'go', 'make',
]);

function validateTests(project) {
  const tests = project.tests ?? {};
  if (!tests || typeof tests !== 'object' || Array.isArray(tests)) throw new Error(`invalid_tests:${project.id}`);
  for (const [alias, spec] of Object.entries(tests)) {
    if (!/^[A-Za-z0-9._-]+$/.test(alias) || !spec || typeof spec !== 'object') throw new Error(`invalid_test:${project.id}`);
    if (!ALLOWED_TEST_COMMANDS.has(spec.command)) throw new Error(`test_command_not_allowed:${project.id}:${alias}`);
    if (!Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new Error(`invalid_test_args:${project.id}:${alias}`);
    }
    const timeout = Number(spec.timeoutMs ?? 600000);
    if (!Number.isFinite(timeout) || timeout < 100 || timeout > 1800000) throw new Error(`invalid_test_timeout:${project.id}:${alias}`);
  }
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
    validateTests(project);
    validateGitHub(project, repositories);

    const stepIds = new Set();
    for (const step of project.steps) {
      if (!step?.id || !step?.action || stepIds.has(step.id)) throw new Error(`invalid_step:${project.id}`);
      stepIds.add(step.id);
      if (!ALLOWED_ACTIONS.has(step.action)) throw new Error(`unsupported_action:${project.id}:${step.id}`);
      const approval = step.approval ?? 'none';
      if (!APPROVALS.has(approval)) throw new Error(`invalid_approval:${project.id}:${step.id}`);
      if (step.action.startsWith('repo.') && (!project.repoPath || !path.isAbsolute(project.repoPath))) {
        throw new Error(`invalid_repo_path:${project.id}`);
      }
      if (step.action === 'repo.test') {
        const alias = step.params?.alias;
        if (typeof alias !== 'string' || !project.tests?.[alias]) {
          throw new Error(`unknown_test_alias:${project.id}:${step.id}`);
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
