import fs from 'node:fs/promises';
import path from 'node:path';
import { operationDefinition } from '../contracts/index.mjs';
import { isDefaultSecretPath } from './read-policy.mjs';

const SERVICE = /^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,126}\.service$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DECISIONS = new Set(['allow', 'approval', 'deny']);
const SCP_REMOTE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s\0]{1,1900}$/;
const WRITE_OPERATIONS = Object.freeze([
  'file.write', 'file.edit', 'file.move',
  'service.start', 'service.stop', 'service.restart',
  'git.commit', 'git.push',
]);

function exact(value, label, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${label}`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`missing_${label}_${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown_${label}_${key}`);
}
function decision(value, label) {
  if (!DECISIONS.has(value)) throw new Error(`invalid_${label}_decision`);
  return value;
}
function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
async function canonicalDir(value, label) {
  if (!path.isAbsolute(String(value || ''))) throw new Error(`${label}_must_be_absolute`);
  const resolved = await fs.realpath(value);
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error(`${label}_not_directory`);
  return resolved;
}
function globRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length < 1 || pattern.length > 128 || /[\0\r\n]/.test(pattern)) throw new Error('invalid_branch_pattern');
  let out='^';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}
function matches(branch, patterns) { return patterns.some((pattern) => pattern.test(branch)); }
function validateRemoteUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || /[\0\r\n]/.test(value)) throw new Error('invalid_write_repository_remote_url');
  if (path.isAbsolute(value)) return path.resolve(value);
  if (SCP_REMOTE.test(value)) return value;
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('invalid_write_repository_remote_url'); }
  if (!['https:', 'ssh:'].includes(parsed.protocol) || !parsed.hostname || parsed.password) throw new Error('invalid_write_repository_remote_url');
  if (parsed.protocol === 'https:' && parsed.username) throw new Error('invalid_write_repository_remote_url');
  return value;
}
function stricter(a,b) {
  const rank={allow:0,approval:1,deny:2};
  return rank[a] >= rank[b] ? a : b;
}

export function phase5WriteCapabilities() {
  return WRITE_OPERATIONS.map((operation) => {
    const definition=operationDefinition(operation);
    return Object.freeze({operation,authority:definition.authority,operationVersion:definition.operationVersion});
  });
}

export class CommanderWritePolicy {
  static async create(config) {
    exact(config,'write_policy',['version','roots','services','repositories']);
    if (config.version !== 1) throw new Error('unsupported_write_policy_version');
    if (!Array.isArray(config.roots) || config.roots.length > 32) throw new Error('invalid_write_roots');
    if (!Array.isArray(config.services) || config.services.length > 64) throw new Error('invalid_write_services');
    if (!Array.isArray(config.repositories) || config.repositories.length > 32) throw new Error('invalid_write_repositories');
    const roots=[];
    for (const item of config.roots) {
      exact(item,'write_root',['path','decision','maxFileBytes']);
      const root=await canonicalDir(item.path,'write_root');
      decision(item.decision,'write_root');
      if (!Number.isSafeInteger(item.maxFileBytes) || item.maxFileBytes < 1 || item.maxFileBytes > 1024*1024) throw new Error('invalid_write_root_file_limit');
      roots.push(Object.freeze({path:root,decision:item.decision,maxFileBytes:item.maxFileBytes}));
    }
    roots.sort((a,b)=>b.path.length-a.path.length);
    const services=new Map();
    for (const item of config.services) {
      exact(item,'write_service',['unit','start','stop','restart']);
      if (typeof item.unit !== 'string' || !SERVICE.test(item.unit) || services.has(item.unit)) throw new Error('invalid_write_service');
      services.set(item.unit,Object.freeze({unit:item.unit,start:decision(item.start,'service_start'),stop:decision(item.stop,'service_stop'),restart:decision(item.restart,'service_restart')}));
    }
    const repositories=new Map();
    for (const item of config.repositories) {
      exact(item,'write_repository',['alias','path','commit','push','remote','remoteUrl','allowedBranches','protectedBranches']);
      if (typeof item.alias !== 'string' || !ALIAS.test(item.alias) || repositories.has(item.alias)) throw new Error('invalid_write_repository_alias');
      const repoPath=await canonicalDir(item.path,'write_repository');
      if (!roots.some((root)=>inside(root.path,repoPath))) throw new Error('write_repository_outside_roots');
      if (typeof item.remote !== 'string' || !ALIAS.test(item.remote)) throw new Error('invalid_write_repository_remote');
      const remoteUrl=validateRemoteUrl(item.remoteUrl);
      const root=roots.find((entry)=>inside(entry.path,repoPath));
      if (!Array.isArray(item.allowedBranches) || item.allowedBranches.length<1 || item.allowedBranches.length>32) throw new Error('invalid_allowed_branches');
      if (!Array.isArray(item.protectedBranches) || item.protectedBranches.length>32) throw new Error('invalid_protected_branches');
      repositories.set(item.alias,Object.freeze({
        alias:item.alias,path:repoPath,root,commit:decision(item.commit,'git_commit'),push:decision(item.push,'git_push'),remote:item.remote,remoteUrl,
        allowedBranches:item.allowedBranches.map(globRegex),protectedBranches:item.protectedBranches.map(globRegex),
      }));
    }
    return new CommanderWritePolicy({roots,services,repositories});
  }
  constructor({roots,services,repositories}) { this.roots=roots; this.services=services; this.repositories=repositories; }

  async resolveFile(candidate,{mustExist=false}={}) {
    if (!path.isAbsolute(String(candidate||''))) throw new Error('WRITE_POLICY_PATH_NOT_ABSOLUTE');
    const absolute=path.resolve(candidate);
    if (isDefaultSecretPath(absolute)) throw new Error('WRITE_POLICY_SECRET_PATH_DENIED');
    let stat=null;
    try { stat=await fs.lstat(absolute); } catch (error) { if (error?.code!=='ENOENT') throw error; }
    if (mustExist && !stat) throw new Error('WRITE_POLICY_PATH_NOT_FOUND');
    if (stat?.isSymbolicLink()) throw new Error('WRITE_POLICY_SYMLINK_DENIED');
    if (stat && !stat.isFile()) throw new Error('WRITE_POLICY_NOT_FILE');
    const resolved=stat ? await fs.realpath(absolute) : path.join(await fs.realpath(path.dirname(absolute)),path.basename(absolute));
    if (isDefaultSecretPath(resolved)) throw new Error('WRITE_POLICY_SECRET_PATH_DENIED');
    const root=this.roots.find((entry)=>inside(entry.path,resolved));
    if (!root) throw new Error('WRITE_POLICY_PATH_OUTSIDE_ROOTS');
    return {path:resolved,exists:Boolean(stat),stat,root};
  }

  service(unit,action) {
    if (typeof unit!=='string' || !SERVICE.test(unit)) throw new Error('WRITE_POLICY_SERVICE_NOT_ALLOWED');
    const item=this.services.get(unit);
    if (!item || !['start','stop','restart'].includes(action)) throw new Error('WRITE_POLICY_SERVICE_NOT_ALLOWED');
    return {resource:`service:${unit}`,decision:item[action],unit};
  }

  repository(alias,action) {
    if (typeof alias!=='string' || !ALIAS.test(alias)) throw new Error('WRITE_POLICY_REPOSITORY_NOT_ALLOWED');
    const repo=this.repositories.get(alias);
    if (!repo || !['commit','push'].includes(action)) throw new Error('WRITE_POLICY_REPOSITORY_NOT_ALLOWED');
    return {repo,decision:stricter(repo.root.decision,repo[action]),resource:`repository:${alias}:${action}`};
  }

  assertBranch(repo,branch) {
    if (typeof branch!=='string' || branch.length<1 || branch.length>255) throw new Error('WRITE_POLICY_INVALID_BRANCH');
    if (matches(branch,repo.protectedBranches)) throw new Error('WRITE_POLICY_PROTECTED_BRANCH');
    if (!matches(branch,repo.allowedBranches)) throw new Error('WRITE_POLICY_BRANCH_NOT_ALLOWED');
    return branch;
  }

  combineFileDecisions(...resolved) {
    let value='allow';
    for (const item of resolved) value=stricter(value,item.root.decision);
    return value;
  }
}

export async function loadCommanderWritePolicy(filePath) {
  if (!path.isAbsolute(String(filePath||''))) throw new Error('write_policy_file_must_be_absolute');
  return CommanderWritePolicy.create(JSON.parse(await fs.readFile(filePath,'utf8')));
}
