import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CodexRpcClient, buildCodexTransport } from '../codex-rpc.mjs';

const MAX_AGENT_EXCERPT = 4000;
const MAX_EVIDENCE = 12000;
const SAFE_ID = /[^A-Za-z0-9._-]/g;

function clip(value, limit) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function safeId(value) {
  return String(value || 'unknown').replace(SAFE_ID, '_').slice(0, 160);
}

function runToken(project, dispatch) {
  const seed = [project.id, dispatch.task?.id, dispatch.stepId, dispatch.attempt].join('|');
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

function failure(code, { retryable = false, detail = '' } = {}) {
  const error = new Error(`coding_worker:${code}${detail ? `:${clip(detail, 500)}` : ''}`);
  error.failure = {
    backend: 'coding', category: 'shadow', code, retryable,
    operation: 'coding.run', newAttempt: true,
  };
  return error;
}

function sshArgs(project, operation) {
  const t = project.transport;
  const args = [
    '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '-i', t.identityFile,
  ];
  if (Number(t.port ?? 22) !== 22) args.push('-p', String(t.port));
  args.push(`${t.user}@${t.host}`, operation);
  return args;
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
}

async function loadLedger(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value?.version !== 1 || !value.runs || typeof value.runs !== 'object' || Array.isArray(value.runs)) {
      throw failure('CODING_LEDGER_INVALID');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, runs: {} };
    if (error?.failure) throw error;
    throw failure('CODING_LEDGER_INVALID');
  }
}

function validateTask(project, dispatch) {
  const task = dispatch.task;
  if (!task || task.source !== 'github') throw failure('CODING_TASK_SOURCE_INVALID');
  if (String(task.repository || '') !== String(project.github?.repository || '')) {
    throw failure('CODING_TASK_REPOSITORY_MISMATCH');
  }
  const issue = Number(task.issueNumber || 0);
  if (!Number.isInteger(issue) || issue < 1) throw failure('CODING_TASK_ISSUE_INVALID');
  const expectedId = `github:${task.repository}#${issue}`;
  if (String(task.id || '') !== expectedId) throw failure('CODING_TASK_ID_MISMATCH');
  if (!String(task.title || '').trim()) throw failure('CODING_TASK_TITLE_MISSING');
  return { ...task, issueNumber: issue };
}

function promptFor(project, task) {
  const instructions = String(project.coding?.instructions || '').trim();
  const body = clip(task.body || '', 8000);
  return [
    'Execute exactly one bounded shadow coding task.',
    `Repository: ${task.repository}`,
    `GitHub issue: #${task.issueNumber}`,
    `Title: ${clip(task.title, 300)}`,
    body ? `Issue body:\n${body}` : 'Issue body: (empty)',
    `Fixed project instructions:\n${clip(instructions, 8000)}`,
    'Constraints: work only in the provided isolated worktree. Do not commit, push, merge, deploy, modify production runtime, use sudo, write hardware/Modbus, or request privilege escalation. Do not start another model turn. Finish this one turn with a concise summary of changes and tests.',
  ].join('\n\n');
}

function normalizedEvidence(value) {
  const changed = Array.isArray(value.changedFiles)
    ? value.changedFiles.slice(0, 25).map((item) => clip(item, 240))
    : [];
  return {
    ...value,
    changedFiles: changed,
    changedFilesTruncated: value.changedFilesTruncated === true || (Array.isArray(value.changedFiles) && value.changedFiles.length > changed.length),
    agentExcerpt: clip(value.agentExcerpt || '', 3500),
  };
}

function evidenceJson(value) {
  const normalized = normalizedEvidence(value);
  const text = JSON.stringify(normalized);
  if (text.length <= MAX_EVIDENCE) return text;
  normalized.agentExcerpt = clip(normalized.agentExcerpt, 1200);
  normalized.changedFiles = normalized.changedFiles.slice(0, 10);
  normalized.changedFilesTruncated = true;
  return JSON.stringify(normalized);
}


function expectedBranch(issue, token) {
  return `autopilot-shadow/${issue}-${token}`;
}

function validateGatewayState(value, task, token, phase) {
  if (!value || value.ok !== true) throw failure(`CODING_GATEWAY_${phase}_INVALID`);
  if (Number(value.issue) !== task.issueNumber || String(value.token || '') !== token) {
    throw failure(`CODING_GATEWAY_${phase}_IDENTITY_MISMATCH`);
  }
  if (String(value.branch || '') !== expectedBranch(task.issueNumber, token)) {
    throw failure(`CODING_GATEWAY_${phase}_BRANCH_MISMATCH`);
  }
  const worktreePath = String(value.worktreePath || '');
  if (!path.isAbsolute(worktreePath) || !worktreePath.endsWith(`/issue-${task.issueNumber}-${token}`)) {
    throw failure(`CODING_GATEWAY_${phase}_PATH_MISMATCH`);
  }
  if (!/^[0-9a-f]{40}$/i.test(String(value.baseHead || ''))) {
    throw failure(`CODING_GATEWAY_${phase}_BASE_INVALID`);
  }
  if (phase === 'INSPECT' && !/^[0-9a-f]{40}$/i.test(String(value.head || ''))) {
    throw failure('CODING_GATEWAY_INSPECT_HEAD_INVALID');
  }
  return value;
}

class OneShotTurn extends EventEmitter {
  constructor({ client, timeoutMs }) {
    super();
    this.client = client;
    this.timeoutMs = timeoutMs;
    this.agentText = '';
    this.turnId = '';
    this.settled = false;
  }

  async run({ cwd, project, prompt }) {
    return new Promise(async (resolve, reject) => {
      const finish = (error, value) => {
        if (this.settled) return;
        this.settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(failure('CODING_TIMEOUT', { retryable: true })), this.timeoutMs);
      this.client.on('notification', (message) => {
        if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
          this.agentText = clip(message.params.item.text || '', MAX_AGENT_EXCERPT);
        }
        if (message.method === 'turn/completed') {
          const turn = message.params?.turn || {};
          if (this.turnId && String(turn.id || '') && String(turn.id) !== this.turnId) return;
          const status = String(turn.status || 'unknown');
          if (status !== 'completed') {
            finish(failure('CODING_TURN_FAILED', { detail: turn.error?.message || status }));
          } else {
            finish(null, { status, turnId: String(turn.id || this.turnId), agentExcerpt: this.agentText });
          }
        }
      });
      this.client.on('serverRequest', (message) => {
        try {
          if (message.method === 'item/permissions/requestApproval') this.client.respond(message.id, { permissions: {} });
          else this.client.respond(message.id, { decision: 'decline' });
        } catch {}
        finish(failure('CODING_APPROVAL_REQUIRED', { detail: message.method }));
      });
      this.client.on('exit', (error) => finish(failure('CODING_UNEXPECTED_EXIT', { retryable: true, detail: error })));
      try {
        await this.client.start();
        const thread = await this.client.request('thread/start', {
          cwd,
          approvalPolicy: project.coding?.approvalPolicy || 'on-request',
          sandbox: 'workspace-write',
          serviceName: 'chatgpt_autopilot_v3_shadow',
          ...(project.coding?.model ? { model: project.coding.model } : {}),
        });
        const threadId = String(thread?.thread?.id || '');
        if (!threadId) return finish(failure('CODING_THREAD_MISSING'));
        const started = await this.client.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt }],
          cwd,
          approvalPolicy: project.coding?.approvalPolicy || 'on-request',
          sandboxPolicy: {
            type: 'workspaceWrite', writableRoots: [cwd], networkAccess: project.coding?.networkAccess === true,
          },
          ...(project.coding?.effort ? { effort: project.coding.effort } : {}),
          summary: 'concise',
        });
        this.turnId = String(started?.turn?.id || '');
        if (!this.turnId) return finish(failure('CODING_TURN_MISSING'));
        this.threadId = threadId;
      } catch (error) {
        finish(error?.failure ? error : failure('CODING_RPC_FAILED', { retryable: true, detail: error }));
      }
    });
  }
}

export class V3CodingWorker {
  constructor({ stateDir, runner, clientFactory = null }) {
    this.stateDir = stateDir;
    this.runner = runner;
    this.clientFactory = clientFactory;
    this.activeKeys = new Set();
  }

  ledgerFile(projectId) {
    return path.join(this.stateDir, 'coding', `${safeId(projectId)}.json`);
  }

  async gateway(project, operation, timeoutMs = 60000) {
    if (project.transport?.type !== 'ssh-gateway') throw failure('CODING_REMOTE_GATEWAY_REQUIRED');
    const result = await this.runner('ssh', sshArgs(project, operation), { timeoutMs });
    const text = String(result.stdout || '').trim();
    if (!text) throw failure('CODING_GATEWAY_EMPTY');
    try { return JSON.parse(text); }
    catch { throw failure('CODING_GATEWAY_INVALID_JSON'); }
  }

  makeClient(project) {
    if (this.clientFactory) return this.clientFactory(project);
    const transport = buildCodexTransport({ id: project.id, codex: { transport: project.coding.codexTransport } });
    return new CodexRpcClient({ ...transport, logger: null, requestTimeoutMs: 30000 });
  }

  async execute(project, dispatch) {
    if (project.coding?.enabled !== true || project.coding?.mode !== 'shadow') throw failure('CODING_DISABLED');
    const task = validateTask(project, dispatch);
    if (!Number.isInteger(dispatch.attempt) || dispatch.attempt < 1) throw failure('CODING_ATTEMPT_INVALID');
    const token = runToken(project, dispatch);
    const key = `${task.id}|${dispatch.stepId}|${dispatch.attempt}`;
    const file = this.ledgerFile(project.id);
    const ledger = await loadLedger(file);
    const previous = ledger.runs?.[key];
    if (previous?.state === 'success') {
      return evidenceJson({ ...previous.evidence, reused: true });
    }
    if (previous || this.activeKeys.has(key)) {
      throw failure(previous?.state === 'failed' ? 'CODING_PREVIOUS_FAILURE' : 'CODING_RUN_ALREADY_ACTIVE');
    }

    this.activeKeys.add(key);
    ledger.runs[key] = { state: 'running', token, startedAt: Date.now() };
    let prepared = null;
    let client = null;
    try {
      await atomicJson(file, ledger);
      prepared = validateGatewayState(
        await this.gateway(project, `coding-prepare ${task.issueNumber} ${token}`, 60000), task, token, 'PREPARE',
      );
      client = this.makeClient(project);
      const turn = new OneShotTurn({ client, timeoutMs: Number(project.coding.timeoutMs || 900000) });
      const completed = await turn.run({ cwd: prepared.worktreePath, project, prompt: promptFor(project, task) });
      const inspected = validateGatewayState(
        await this.gateway(project, `coding-inspect ${task.issueNumber} ${token}`, 30000), task, token, 'INSPECT',
      );
      if (inspected.headChanged) throw failure('CODING_GIT_HISTORY_CHANGED');
      const evidence = {
        mode: 'shadow', issueNumber: task.issueNumber, token,
        branch: inspected.branch, worktreePath: inspected.worktreePath,
        baseHead: inspected.baseHead, head: inspected.head,
        changedFiles: Array.isArray(inspected.changedFiles) ? inspected.changedFiles : [],
        dirty: inspected.dirty === true,
        threadId: String(turn.threadId || ''), turnId: completed.turnId,
        agentExcerpt: completed.agentExcerpt || '',
        reused: false,
      };
      const normalized = normalizedEvidence(evidence);
      ledger.runs[key] = { state: 'success', token, completedAt: Date.now(), evidence: normalized };
      await atomicJson(file, ledger);
      if (!normalized.dirty) {
        await this.gateway(project, `coding-cleanup ${task.issueNumber} ${token}`, 60000);
        normalized.worktreeRetained = false;
        ledger.runs[key].evidence = normalized;
        await atomicJson(file, ledger);
      } else {
        normalized.worktreeRetained = true;
        ledger.runs[key].evidence = normalized;
        await atomicJson(file, ledger);
      }
      return evidenceJson(normalized);
    } catch (error) {
      ledger.runs[key] = {
        state: 'failed', token, completedAt: Date.now(),
        code: String(error?.failure?.code || 'CODING_FAILED').slice(0, 160),
        worktreePath: String(prepared?.worktreePath || '').slice(0, 500),
      };
      await atomicJson(file, ledger).catch(() => {});
      if (prepared) {
        await this.gateway(project, `coding-cleanup ${task.issueNumber} ${token}`, 60000).catch(() => {});
      }
      throw error?.failure ? error : failure('CODING_FAILED', { detail: error });
    } finally {
      this.activeKeys.delete(key);
      await client?.close?.().catch?.(() => {});
    }
  }
}

export { promptFor, runToken };
