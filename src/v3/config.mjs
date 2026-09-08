import fs from 'node:fs/promises';

const APPROVALS = new Set(['none', 'user']);

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || value.version !== 3 || !Array.isArray(value.projects)) {
    throw new Error('invalid_v3_config');
  }
  const ids = new Set();
  for (const project of value.projects) {
    if (!project || typeof project !== 'object' || !project.id || ids.has(project.id)) {
      throw new Error('invalid_project_id');
    }
    ids.add(project.id);
    if (!Array.isArray(project.steps) || project.steps.length === 0) throw new Error(`missing_steps:${project.id}`);
    const stepIds = new Set();
    for (const step of project.steps) {
      if (!step?.id || !step?.action || stepIds.has(step.id)) throw new Error(`invalid_step:${project.id}`);
      stepIds.add(step.id);
      const approval = step.approval ?? 'none';
      if (!APPROVALS.has(approval)) throw new Error(`invalid_approval:${project.id}:${step.id}`);
    }
  }
  return value;
}

export async function loadConfig(path) {
  const raw = await fs.readFile(path, 'utf8');
  return validateConfig(JSON.parse(raw));
}

export function projectById(config, id) {
  const project = config.projects.find((item) => item.id === id && item.enabled !== false);
  if (!project) throw new Error(`unknown_or_disabled_project:${id}`);
  return project;
}
