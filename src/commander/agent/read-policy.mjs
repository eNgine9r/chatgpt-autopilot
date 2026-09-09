import fs from 'node:fs/promises';
import path from 'node:path';
import { operationDefinition } from '../contracts/index.mjs';

export const PHASE3_READ_OPERATIONS = Object.freeze([
  'device.health',
  'file.read', 'file.list', 'file.info', 'file.search',
  'process.list', 'service.status',
  'git.status', 'git.diff', 'git.log',
]);

const SERVICE = /^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,126}\.service$/;
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.azure', '.docker', '.git', '.hg', '.svn']);
const SECRET_NAMES = new Set([
  '.env', '.npmrc', '.pypirc', 'credentials', 'credentials.json', 'secrets.json',
  'id_rsa', 'id_ed25519', 'authorized_keys', 'known_hosts',
]);
const SAFE_ENV_SUFFIXES = new Set(['.env.example', '.env.sample', '.env.template']);

function exactObject(value, label, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${label}`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`missing_${label}_${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown_${label}_${key}`);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function isDefaultSecretPath(candidate) {
  const parts = path.resolve(candidate).split(path.sep).filter(Boolean);
  if (parts.some((part) => SECRET_DIRS.has(part))) return true;
  const name = parts.at(-1) || '';
  if (SAFE_ENV_SUFFIXES.has(name)) return false;
  if (SECRET_NAMES.has(name) || (name.startsWith('.env.') && !SAFE_ENV_SUFFIXES.has(name))) return true;
  if (/\.(?:pem|key|p12|pfx)$/i.test(name)) return true;
  return false;
}

async function canonicalDirectory(value, label) {
  if (!path.isAbsolute(String(value || ''))) throw new Error(`${label}_must_be_absolute`);
  const resolved = await fs.realpath(value);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error(`${label}_not_directory`);
  return resolved;
}

export function phase3ReadCapabilities() {
  return PHASE3_READ_OPERATIONS.map((operation) => {
    const definition = operationDefinition(operation);
    return Object.freeze({ operation, authority: definition.authority, operationVersion: definition.operationVersion });
  });
}

export class CommanderReadOnlyPolicy {
  static async create(config) {
    exactObject(config, 'read_policy', ['version', 'roots', 'repositories', 'services']);
    if (config.version !== 1) throw new Error('unsupported_read_policy_version');
    if (!Array.isArray(config.roots) || config.roots.length > 32) throw new Error('invalid_read_policy_roots');
    if (!Array.isArray(config.repositories) || config.repositories.length > 32) throw new Error('invalid_read_policy_repositories');
    if (!Array.isArray(config.services) || config.services.length > 64) throw new Error('invalid_read_policy_services');
    const roots = [];
    for (const item of config.roots) roots.push(await canonicalDirectory(item, 'read_root'));
    const repositories = [];
    for (const item of config.repositories) {
      const repository = await canonicalDirectory(item, 'repository_root');
      if (!roots.some((root) => inside(root, repository))) throw new Error('repository_outside_read_roots');
      repositories.push(repository);
    }
    const services = new Set();
    for (const service of config.services) {
      if (typeof service !== 'string' || !SERVICE.test(service)) throw new Error('invalid_service_allowlist_entry');
      services.add(service);
    }
    return new CommanderReadOnlyPolicy({ roots, repositories, services });
  }

  constructor({ roots, repositories, services }) {
    this.roots = Object.freeze([...new Set(roots)]);
    this.repositories = Object.freeze([...new Set(repositories)]);
    this.services = new Set(services);
  }

  async assertPath(candidate) {
    if (!path.isAbsolute(String(candidate || ''))) throw new Error('READ_POLICY_PATH_NOT_ABSOLUTE');
    const resolved = await fs.realpath(candidate).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error('READ_POLICY_PATH_NOT_FOUND');
      throw error;
    });
    if (!this.roots.some((root) => inside(root, resolved))) throw new Error('READ_POLICY_PATH_OUTSIDE_ROOTS');
    if (isDefaultSecretPath(resolved)) throw new Error('READ_POLICY_SECRET_PATH_DENIED');
    return resolved;
  }

  async assertRepository(candidate) {
    const resolved = await this.assertPath(candidate);
    if (!this.repositories.includes(resolved)) throw new Error('READ_POLICY_REPOSITORY_NOT_ALLOWED');
    return resolved;
  }

  assertService(service) {
    if (typeof service !== 'string' || !SERVICE.test(service) || !this.services.has(service)) {
      throw new Error('READ_POLICY_SERVICE_NOT_ALLOWED');
    }
    return service;
  }
}

export async function loadCommanderReadPolicy(filePath) {
  if (!path.isAbsolute(String(filePath || ''))) throw new Error('read_policy_file_must_be_absolute');
  const raw = await fs.readFile(filePath, 'utf8');
  return CommanderReadOnlyPolicy.create(JSON.parse(raw));
}
