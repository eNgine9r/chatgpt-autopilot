import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_VERSION = 1;
const PROJECT_ID = /^[A-Za-z0-9._-]{1,120}$/;

function bounded(value, limit = 500) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function defaultState() {
  return { version: STATE_VERSION, offset: 0, notified: {} };
}

export function isAuthorized(message, ownerUserId, chatId) {
  return String(message?.from?.id ?? '') === String(ownerUserId)
    && String(message?.chat?.id ?? '') === String(chatId);
}

export function parseTelegramCommand(text) {
  const raw = String(text ?? '').trim();
  const match = raw.match(/^\/(v3|status|approve|retry)(?:@[A-Za-z0-9_]+)?(?:\s+([^\s]+))?\s*$/i);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const projectId = match[2] ?? '';
  if (command === 'v3' || command === 'status') return { kind: 'status' };
  if (!PROJECT_ID.test(projectId)) return { kind: 'invalid', command };
  return { kind: command, projectId };
}

export function currentStepId(config, state) {
  const project = config.projects.find((item) => item.id === state.projectId);
  return project?.steps?.[state.stepIndex]?.id ?? '';
}

export function stateFingerprint(state) {
  const taskId = state.task?.id ?? '';
  return [state.status, taskId, state.stepIndex, state.lastError ?? ''].join('|');
}

export function statusSummary(projects) {
  const lines = ['Autopilot v3'];
  for (const state of projects) {
    const task = bounded(state.task?.title || state.task?.id || '—', 90);
    lines.push(`${state.projectId}: ${state.status} · ${task}`);
  }
  return lines.join('\n').slice(0, 3500);
}

export function notificationFor(state) {
  const task = bounded(state.task?.title || state.task?.id || '—', 180);
  if (state.status === 'waiting_approval') {
    return `⏸ ${state.projectId} очікує підтвердження\n${task}\n/approve ${state.projectId}`;
  }
  if (state.status === 'blocked') {
    return `🔴 ${state.projectId} заблоковано\n${bounded(state.lastError || 'unknown_error', 500)}\n/retry ${state.projectId}`;
  }
  if (state.status === 'complete') return `✅ ${state.projectId} завершено\n${task}`;
  return '';
}

export class TelegramBridgeStateStore {
  constructor(file) {
    this.file = file;
  }

  async load() {
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (value?.version !== STATE_VERSION || !Number.isInteger(value.offset) || value.offset < 0) {
        throw new Error('invalid_telegram_state');
      }
      return { version: STATE_VERSION, offset: value.offset, notified: value.notified ?? {} };
    } catch (error) {
      if (error.code === 'ENOENT') return defaultState();
      throw error;
    }
  }

  async save(value) {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await fs.rename(tmp, this.file);
    await fs.chmod(this.file, 0o600);
  }
}

export class TelegramBridge {
  constructor({ config, store, telegram, localApi, ownerUserId, chatId }) {
    this.config = config;
    this.store = store;
    this.telegram = telegram;
    this.localApi = localApi;
    this.ownerUserId = String(ownerUserId);
    this.chatId = String(chatId);
  }

  async scanStates() {
    const projects = await this.localApi.getProjects();
    const state = await this.store.load();
    let changed = false;
    for (const project of projects) {
      const fingerprint = stateFingerprint(project);
      const previous = state.notified[project.projectId];
      if (previous === fingerprint) continue;
      const text = notificationFor(project);
      const shouldSend = Boolean(text) && (project.status !== 'complete' || Boolean(previous));
      if (shouldSend) {
        const sent = await this.telegram.sendMessage(this.chatId, text);
        if (!sent) continue;
      }
      state.notified[project.projectId] = fingerprint;
      changed = true;
    }
    if (changed) await this.store.save(state);
    return projects;
  }

  async handleCommand(update, command, projects) {
    if (command.kind === 'status') {
      return this.telegram.sendMessage(this.chatId, statusSummary(projects));
    }
    if (command.kind === 'invalid') {
      return this.telegram.sendMessage(this.chatId, `Формат: /${command.command} <project-id>`);
    }
    const state = projects.find((item) => item.projectId === command.projectId);
    if (!state) return this.telegram.sendMessage(this.chatId, `Невідомий project-id: ${command.projectId}`);

    if (command.kind === 'approve') {
      if (state.status !== 'waiting_approval') {
        return this.telegram.sendMessage(this.chatId, `${state.projectId}: approval недоступний у стані ${state.status}`);
      }
      const stepId = currentStepId(this.config, state);
      if (!stepId) throw new Error(`missing_current_step:${state.projectId}`);
      await this.localApi.postEvent({
        id: `telegram:${update.update_id}:approve:${state.projectId}`,
        projectId: state.projectId,
        kind: 'approval.granted',
        stepId,
      });
      return this.telegram.sendMessage(this.chatId, `✅ ${state.projectId}: підтвердження прийнято`);
    }

    if (command.kind === 'retry') {
      if (state.status !== 'blocked') {
        return this.telegram.sendMessage(this.chatId, `${state.projectId}: retry недоступний у стані ${state.status}`);
      }
      await this.localApi.postEvent({
        id: `telegram:${update.update_id}:retry:${state.projectId}`,
        projectId: state.projectId,
        kind: 'retry',
      });
      return this.telegram.sendMessage(this.chatId, `🔁 ${state.projectId}: retry запущено`);
    }
    return false;
  }

  async processUpdates(updates) {
    const state = await this.store.load();
    let projects = null;
    for (const update of [...updates].sort((a, b) => Number(a.update_id) - Number(b.update_id))) {
      const updateId = Number(update.update_id);
      if (!Number.isInteger(updateId) || updateId < state.offset) continue;
      const message = update.message;
      if (message && isAuthorized(message, this.ownerUserId, this.chatId)) {
        const command = parseTelegramCommand(message.text);
        if (command) {
          projects ??= await this.localApi.getProjects();
          await this.handleCommand(update, command, projects);
          projects = null;
        }
      }
      state.offset = Math.max(state.offset, updateId + 1);
    }
    await this.store.save(state);
    return state.offset;
  }
}
