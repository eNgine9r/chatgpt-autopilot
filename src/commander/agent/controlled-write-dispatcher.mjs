import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { commanderError, operationDefinition, protocolEnvelope, validateOperationResult } from '../contracts/index.mjs';
import { runWriteCommand } from './write-command.mjs';

const MAX_REPLAY = 1024;
const MAX_TEXT_PARAM = 1024 * 1024;
const MAX_COMMIT_MESSAGE = 4096;

function exact(value, label, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${label}`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`missing_${label}_${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown_${label}_${key}`);
}
function text(value, label, { min = 0, max = MAX_TEXT_PARAM } = {}) {
  if (typeof value !== 'string' || value.length < min || Buffer.byteLength(value) > max || value.includes('\0')) throw new Error(`invalid_${label}`);
  return value;
}
function positiveInt(value, label, min = 1, max = 10000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid_${label}`);
  return value;
}
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function nowIso(now) { return new Date(now()).toISOString(); }
function stableFingerprint(operation, params) {
  const semantic = { ...params }; delete semantic.approval;
  return sha256(Buffer.from(JSON.stringify([operation, semantic])));
}
function safeRelative(value) {
  text(value, 'git_path', { min: 1, max: 2048 });
  if (path.isAbsolute(value) || value === '..' || value.startsWith('../') || value.includes('/../') || value.includes('\\')) throw new Error('invalid_git_path');
  return value.replace(/^\.\//, '');
}
function parseShow(stdout) {
  const out = {};
  for (const line of stdout.split(/\r?\n/)) {
    const i = line.indexOf('='); if (i < 1) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return { loadState: out.LoadState || 'unknown', activeState: out.ActiveState || 'unknown', subState: out.SubState || 'unknown', unitFileState: out.UnitFileState || 'unknown', mainPid: Number(out.MainPID || 0) || 0 };
}
function gitBase() { return ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','diff.external=','-c','credential.helper=','-c','commit.gpgSign=false','-c','protocol.ext.allow=never','-c','core.sshCommand=/usr/bin/ssh -F /dev/null -o BatchMode=yes -o ClearAllForwardings=yes']; }

export class CommanderControlledWriteDispatcher {
  constructor({ deviceId, policy, approvalVerifier = null, commandRunner = runWriteCommand, logger = console, now = Date.now } = {}) {
    if (!deviceId || !policy) throw new Error('write_dispatcher_configuration_required');
    if (approvalVerifier !== null && typeof approvalVerifier !== 'function') throw new Error('invalid_approval_verifier');
    this.deviceId = deviceId; this.policy = policy; this.approvalVerifier = approvalVerifier; this.commandRunner = commandRunner; this.logger = logger; this.now = now;
    this.replay = new Map();
    this.inFlight = new Map();
  }

  async handle(request) {
    const definition = operationDefinition(request.operation);
    if (request.deviceId !== this.deviceId) throw new Error('controlled_write_device_mismatch');
    if (definition.authority !== 'write' || request.operation.startsWith('execution.')) throw new Error('controlled_write_operation_not_supported');
    const fingerprint = stableFingerprint(request.operation, request.params);
    const prior = this.replay.get(request.idempotencyKey);
    if (prior) return this.#replayResult(request, fingerprint, prior);
    const active = this.inFlight.get(request.idempotencyKey);
    if (active) {
      if (active.operation !== request.operation || active.deviceId !== request.deviceId || active.fingerprint !== fingerprint) return this.#conflict(request, `operation:${request.operation}`);
      const result = await active.promise;
      this.#audit(request, active.resource || `operation:${request.operation}`, active.decision || 'allow', 'inflight_replay', result.data?.evidence);
      return validateOperationResult({ ...result, requestId: request.requestId, completedAt: nowIso(this.now) });
    }
    const holder = { operation: request.operation, deviceId: request.deviceId, fingerprint, resource: '', decision: '' };
    holder.promise = this.#execute(request, fingerprint, holder);
    this.inFlight.set(request.idempotencyKey, holder);
    try { return await holder.promise; }
    finally { if (this.inFlight.get(request.idempotencyKey) === holder) this.inFlight.delete(request.idempotencyKey); }
  }

  #replayResult(request, fingerprint, prior) {
    if (prior.operation !== request.operation || prior.deviceId !== request.deviceId || prior.fingerprint !== fingerprint) return this.#conflict(request, prior.resource);
    this.#audit(request, prior.resource, prior.decision, 'replay', prior.result.data?.evidence);
    return validateOperationResult({ ...prior.result, requestId: request.requestId, completedAt: nowIso(this.now) });
  }

  #conflict(request, resource) {
    this.#audit(request, resource, 'deny', 'idempotency_conflict');
    return this.#result(request, { ok: false, error: commanderError({ category: 'conflict', code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'Idempotency key was already used with different request semantics.', retryable: false }) });
  }

  async #execute(request, fingerprint, holder) {
    try {
      const plan = await this.#plan(request);
      holder.resource = plan.resource; holder.decision = plan.decision;
      if (plan.decision === 'deny') return this.#denied(request, plan, 'WRITE_POLICY_DENIED', 'Controlled write is denied by policy.');
      if (plan.decision === 'approval') {
        const approved = this.approvalVerifier ? await this.approvalVerifier({ request, resource: plan.resource, approval: request.params.approval, fingerprint }) : false;
        if (!approved) {
          this.#audit(request, plan.resource, plan.decision, 'requires_approval');
          return this.#result(request, { ok: false, data: { decision: 'requires_approval', resource: plan.resource }, error: commanderError({ category: 'authorization', code: 'REQUIRES_APPROVAL', message: 'Explicit approval is required before this mutation.', retryable: true }) });
        }
      }
      const data = await plan.apply();
      const result = this.#result(request, { data: { decision: 'applied', resource: plan.resource, ...data } });
      this.#remember(request, fingerprint, plan, result);
      this.#audit(request, plan.resource, plan.decision, 'applied', data.evidence);
      return result;
    } catch (error) {
      const code = String(error?.message || error).split(':')[0].slice(0, 63).toUpperCase().replace(/[^A-Z0-9_]/g, '_') || 'WRITE_FAILED';
      this.#audit(request, holder.resource || `operation:${request.operation}`, holder.decision || 'deny', 'failed', { code });
      return this.#result(request, { ok: false, error: commanderError({ category: code.startsWith('WRITE_POLICY_') ? 'policy' : 'execution', code, message: 'Controlled write request failed safely.', retryable: false }) });
    }
  }

  #remember(request, fingerprint, plan, result) {
    this.replay.set(request.idempotencyKey, { operation: request.operation, deviceId: request.deviceId, fingerprint, resource: plan.resource, decision: plan.decision, result });
    while (this.replay.size > MAX_REPLAY) this.replay.delete(this.replay.keys().next().value);
  }
  #result(request, { ok = true, data, error } = {}) {
    return validateOperationResult({ ...protocolEnvelope(), requestId: request.requestId, deviceId: request.deviceId, operation: request.operation, ok, completedAt: nowIso(this.now), ...(data === undefined ? {} : { data }), ...(error ? { error } : {}) });
  }
  #denied(request, plan, code, message) {
    this.#audit(request, plan.resource, plan.decision, 'denied');
    return this.#result(request, { ok: false, data: { decision: 'denied', resource: plan.resource }, error: commanderError({ category: 'policy', code, message, retryable: false }) });
  }
  #audit(request, resource, decision, outcome, evidence) {
    try { this.logger?.info?.('commander_write_audit', { requestId: request.requestId, deviceId: request.deviceId, operation: request.operation, resource, decision, outcome, ...(evidence ? { evidence } : {}) }); } catch {}
  }

  async #plan(request) {
    switch (request.operation) {
      case 'file.write': return this.#fileWritePlan(request.params);
      case 'file.edit': return this.#fileEditPlan(request.params);
      case 'file.move': return this.#fileMovePlan(request.params);
      case 'service.start': return this.#servicePlan(request.params, 'start');
      case 'service.stop': return this.#servicePlan(request.params, 'stop');
      case 'service.restart': return this.#servicePlan(request.params, 'restart');
      case 'git.commit': return this.#gitCommitPlan(request.params);
      case 'git.push': return this.#gitPushPlan(request.params);
      default: throw new Error('WRITE_OPERATION_NOT_IMPLEMENTED');
    }
  }

  async #fileWritePlan(params) {
    exact(params, 'file_write_params', ['path','content','mode'], ['approval']);
    text(params.content, 'file_content');
    if (!['create','replace','upsert'].includes(params.mode)) throw new Error('invalid_file_write_mode');
    const target = await this.policy.resolveFile(params.path);
    if (params.mode === 'create' && target.exists) throw new Error('WRITE_POLICY_CREATE_EXISTS');
    if (params.mode === 'replace' && !target.exists) throw new Error('WRITE_POLICY_REPLACE_MISSING');
    const bytes = Buffer.byteLength(params.content);
    if (bytes > target.root.maxFileBytes) throw new Error('WRITE_POLICY_FILE_TOO_LARGE');
    return { resource: `file:${target.path}`, decision: target.root.decision, apply: () => this.#atomicWrite(target, Buffer.from(params.content)) };
  }

  async #fileEditPlan(params) {
    exact(params, 'file_edit_params', ['path','oldText','newText','expectedReplacements'], ['approval']);
    text(params.oldText, 'old_text', { min: 1 }); text(params.newText, 'new_text'); positiveInt(params.expectedReplacements, 'expected_replacements', 1, 10000);
    const target = await this.policy.resolveFile(params.path, { mustExist: true });
    return { resource: `file:${target.path}`, decision: target.root.decision, apply: async () => {
      const before = await fs.readFile(target.path); let source;
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(before); } catch { throw new Error('WRITE_EDIT_NOT_UTF8'); }
      const count = source.split(params.oldText).length - 1;
      if (count !== params.expectedReplacements) throw new Error('WRITE_EDIT_REPLACEMENT_COUNT_MISMATCH');
      const next = source.split(params.oldText).join(params.newText); const buffer = Buffer.from(next);
      if (buffer.length > target.root.maxFileBytes) throw new Error('WRITE_POLICY_FILE_TOO_LARGE');
      const data = await this.#atomicWrite(target, buffer, before);
      return { ...data, evidence: { ...data.evidence, replacements: count } };
    }};
  }

  async #fileMovePlan(params) {
    exact(params, 'file_move_params', ['source','destination'], ['approval']);
    const source = await this.policy.resolveFile(params.source, { mustExist: true });
    const destination = await this.policy.resolveFile(params.destination);
    if (destination.exists) throw new Error('WRITE_MOVE_DESTINATION_EXISTS');
    const decision = this.policy.combineFileDecisions(source, destination);
    return { resource: `move:${source.path}->${destination.path}`, decision, apply: async () => {
      const before = await fs.readFile(source.path); await fs.rename(source.path, destination.path);
      return { evidence: { source: source.path, destination: destination.path, sha256: sha256(before), bytes: before.length, mutated: true }, rollback: { action: 'move', from: destination.path, to: source.path } };
    }};
  }

  async #atomicWrite(target, buffer, suppliedBefore = null) {
    const before = suppliedBefore ?? (target.exists ? await fs.readFile(target.path) : null);
    const mode = target.stat ? (target.stat.mode & 0o777) : 0o600;
    const temp = path.join(path.dirname(target.path), `.${path.basename(target.path)}.commander-${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      await fs.writeFile(temp, buffer, { flag: 'wx', mode: 0o600 }); await fs.chmod(temp, mode); await fs.rename(temp, target.path);
    } catch (error) { await fs.rm(temp, { force: true }).catch(() => {}); throw error; }
    return { evidence: { path: target.path, beforeExists: Boolean(before), beforeSha256: before ? sha256(before) : null, afterSha256: sha256(buffer), bytes: buffer.length, mutated: true }, rollback: before ? { action: 'manual_restore', expectedPriorSha256: sha256(before) } : { action: 'delete_created_file', path: target.path } };
  }

  #servicePlan(params, action) {
    exact(params, 'service_params', ['unit'], ['approval']);
    const rule = this.policy.service(params.unit, action);
    return { resource: rule.resource, decision: rule.decision, apply: async () => {
      const before = await this.#serviceStatus(rule.unit);
      const result = await this.commandRunner('systemctl', ['--user', action, rule.unit], { timeoutMs: 30_000 });
      if (result.exitCode !== 0 || result.timedOut) throw new Error('WRITE_SERVICE_ACTION_FAILED');
      const after = await this.#serviceStatus(rule.unit);
      return { evidence: { unit: rule.unit, action, before, after, mutated: true }, rollback: { action: before.activeState === 'active' ? 'start' : 'stop', unit: rule.unit } };
    }};
  }
  async #serviceStatus(unit) {
    const result = await this.commandRunner('systemctl', ['--user','show',unit,'--property=LoadState,ActiveState,SubState,UnitFileState,MainPID','--no-pager'], { timeoutMs: 10_000 });
    if (result.exitCode !== 0 || result.timedOut) throw new Error('WRITE_SERVICE_STATUS_FAILED');
    return parseShow(result.stdout);
  }

  async #gitBranch(repo) {
    const result = await this.commandRunner('git', [...gitBase(),'symbolic-ref','--quiet','--short','HEAD'], { cwd: repo.path, timeoutMs: 10_000 });
    if (result.exitCode !== 0 || result.timedOut) throw new Error('WRITE_GIT_DETACHED_HEAD');
    return this.policy.assertBranch(repo, result.stdout.trim());
  }
  async #gitHead(repo) {
    const result = await this.commandRunner('git', [...gitBase(),'rev-parse','HEAD'], { cwd: repo.path, timeoutMs: 10_000 });
    if (result.exitCode !== 0 || result.timedOut) throw new Error('WRITE_GIT_HEAD_FAILED');
    return result.stdout.trim();
  }

  async #gitCommitPlan(params) {
    exact(params, 'git_commit_params', ['repo','message','paths'], ['approval']);
    text(params.message, 'commit_message', { min: 1, max: MAX_COMMIT_MESSAGE });
    if (!Array.isArray(params.paths) || params.paths.length < 1 || params.paths.length > 64) throw new Error('invalid_git_paths');
    const rule = this.policy.repository(params.repo, 'commit'); const paths = [...new Set(params.paths.map(safeRelative))];
    const files = [];
    for (const rel of paths) {
      const expected = path.resolve(rule.repo.path, rel);
      const resolved = await this.policy.resolveFile(expected, { mustExist: true });
      if (resolved.path !== expected) throw new Error('WRITE_POLICY_GIT_PATH_SYMLINK');
      files.push({ rel, path: resolved.path, mode: (resolved.stat.mode & 0o111) ? '100755' : '100644' });
    }
    const branch = await this.#gitBranch(rule.repo);
    return { resource: `${rule.resource}:${branch}`, decision: rule.decision, apply: async () => {
      const beforeHead = await this.#gitHead(rule.repo);
      const staged = await this.commandRunner('git', [...gitBase(),'diff','--cached','--name-only'], { cwd: rule.repo.path, timeoutMs: 10_000 });
      if (staged.exitCode !== 0 || staged.timedOut || staged.stdout.trim()) throw new Error('WRITE_GIT_PREEXISTING_STAGED_CHANGES');
      let indexMutated = false;
      try {
        for (const file of files) {
          const hashed = await this.commandRunner('git', [...gitBase(),'hash-object','-w','--no-filters','--',file.rel], { cwd: rule.repo.path, timeoutMs: 15_000 });
          const blob = hashed.stdout.trim();
          if (hashed.exitCode !== 0 || hashed.timedOut || !/^[0-9a-f]{40,64}$/.test(blob)) throw new Error('WRITE_GIT_HASH_FAILED');
          const updated = await this.commandRunner('git', [...gitBase(),'update-index','--add','--cacheinfo',`${file.mode},${blob},${file.rel}`], { cwd: rule.repo.path, timeoutMs: 15_000 });
          if (updated.exitCode !== 0 || updated.timedOut) throw new Error('WRITE_GIT_INDEX_FAILED');
          indexMutated = true;
        }
        const changed = await this.commandRunner('git', [...gitBase(),'diff','--cached','--quiet'], { cwd: rule.repo.path, timeoutMs: 10_000 });
        if (changed.timedOut || ![0,1].includes(changed.exitCode)) throw new Error('WRITE_GIT_DIFF_FAILED');
        if (changed.exitCode === 0) throw new Error('WRITE_GIT_NO_CHANGES');
        const tree = await this.commandRunner('git', [...gitBase(),'write-tree'], { cwd: rule.repo.path, timeoutMs: 15_000 });
        const treeId = tree.stdout.trim();
        if (tree.exitCode !== 0 || tree.timedOut || !/^[0-9a-f]{40,64}$/.test(treeId)) throw new Error('WRITE_GIT_WRITE_TREE_FAILED');
        const commit = await this.commandRunner('git', [...gitBase(),'commit-tree',treeId,'-p',beforeHead,'-m',params.message], { cwd: rule.repo.path, timeoutMs: 30_000 });
        const afterHead = commit.stdout.trim();
        if (commit.exitCode !== 0 || commit.timedOut || !/^[0-9a-f]{40,64}$/.test(afterHead)) throw new Error('WRITE_GIT_COMMIT_TREE_FAILED');
        const ref = `refs/heads/${branch}`;
        const updateRef = await this.commandRunner('git', [...gitBase(),'update-ref',ref,afterHead,beforeHead], { cwd: rule.repo.path, timeoutMs: 15_000 });
        if (updateRef.exitCode !== 0 || updateRef.timedOut) throw new Error('WRITE_GIT_UPDATE_REF_FAILED');
        indexMutated = false;
        return { evidence: { repo: rule.repo.alias, branch, paths, beforeHead, afterHead, tree: treeId, mutated: beforeHead !== afterHead, filtersBypassed: true }, rollback: { action: 'operator_restore_commit', ref: beforeHead } };
      } catch (error) {
        if (indexMutated) await this.commandRunner('git', [...gitBase(),'read-tree','--reset',beforeHead], { cwd: rule.repo.path, timeoutMs: 10_000 }).catch(() => {});
        throw error;
      }
    }};
  }

  async #gitPushPlan(params) {
    exact(params, 'git_push_params', ['repo'], ['approval']);
    const rule = this.policy.repository(params.repo, 'push'); const branch = await this.#gitBranch(rule.repo);
    return { resource: `${rule.resource}:${branch}`, decision: rule.decision, apply: async () => {
      const localHead = await this.#gitHead(rule.repo); const ref = `refs/heads/${branch}`;
      const configured = await this.commandRunner('git', [...gitBase(),'remote','get-url','--push','--all',rule.repo.remote], { cwd: rule.repo.path, timeoutMs: 10_000 });
      const configuredUrls = configured.stdout.split(/\r?\n/).map((line)=>line.trim()).filter(Boolean);
      if (configured.exitCode !== 0 || configured.timedOut || configuredUrls.length !== 1 || configuredUrls[0] !== rule.repo.remoteUrl) throw new Error('WRITE_GIT_REMOTE_MISMATCH');
      const before = await this.commandRunner('git', [...gitBase(),'ls-remote','--heads',rule.repo.remoteUrl,ref], { cwd: rule.repo.path, timeoutMs: 30_000 });
      if (before.exitCode !== 0 || before.timedOut) throw new Error('WRITE_GIT_REMOTE_QUERY_FAILED');
      const priorRemoteHead = before.stdout.trim().split(/\s+/)[0] || null;
      const push = await this.commandRunner('git', [...gitBase(),'push','--porcelain',rule.repo.remoteUrl,`HEAD:${ref}`], { cwd: rule.repo.path, timeoutMs: 120_000 });
      if (push.exitCode !== 0 || push.timedOut) throw new Error('WRITE_GIT_PUSH_FAILED');
      return { evidence: { repo: rule.repo.alias, branch, remote: rule.repo.remote, remoteUrl: rule.repo.remoteUrl, priorRemoteHead, localHead, mutated: priorRemoteHead !== localHead }, rollback: { action: 'operator_restore_remote_ref', remote: rule.repo.remote, branch, priorRemoteHead } };
    }};
  }
}
