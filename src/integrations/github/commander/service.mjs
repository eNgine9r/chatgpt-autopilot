#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { commanderPublicClientFromEnv } from '../../../commander/client/client.mjs';
import {
  executeCommanderGithubTask,
  githubBridgeComment,
  githubBridgeFailure,
  parseAllowedOperations,
} from './bridge.mjs';
import { CommanderGithubClient } from './github-client.mjs';

function enabled(value) { return String(value ?? '').toLowerCase() === 'true'; }
function boundedInt(value, fallback, min, max, code) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(code);
  return parsed;
}

export function githubBridgeConfig(env = process.env) {
  const repository = env.COMMANDER_GITHUB_REPOSITORY;
  const allowedAuthor = env.COMMANDER_GITHUB_ALLOWED_AUTHOR;
  if (!repository) throw new Error('COMMANDER_GITHUB_REPOSITORY_required');
  if (!allowedAuthor) throw new Error('COMMANDER_GITHUB_ALLOWED_AUTHOR_required');
  return Object.freeze({
    repository,
    allowedAuthor,
    taskLabel: env.COMMANDER_GITHUB_TASK_LABEL || 'commander/task',
    pollMs: boundedInt(env.COMMANDER_GITHUB_POLL_MS, 3_000, 3_000, 300_000, 'invalid_github_bridge_poll_ms'),
    maxIssues: boundedInt(env.COMMANDER_GITHUB_MAX_ISSUES, 10, 1, 50, 'invalid_github_bridge_max_issues'),
    allowedOperations: parseAllowedOperations(env.COMMANDER_GITHUB_ALLOWED_OPERATIONS),
    ghBin: env.COMMANDER_GITHUB_GH_BIN || '/usr/bin/gh',
  });
}

async function finalizeIssue(github, issueNumber, payload) {
  let comment;
  try { comment = githubBridgeComment(payload); }
  catch (error) { comment = githubBridgeComment(githubBridgeFailure(issueNumber, error)); }
  await github.addComment(issueNumber, comment);
  await github.closeIssue(issueNumber);
}

export async function runGithubBridgeCycle({ config, github, client, logger = console } = {}) {
  const issues = await github.listOpenTasks(config.taskLabel, config.maxIssues);
  let completed = 0;
  for (const issue of issues) {
    try {
      const result = await executeCommanderGithubTask({ issue, config, client });
      await finalizeIssue(github, issue.number, result);
      completed += 1;
      logger.info(JSON.stringify({ event: 'commander_github_task_complete', issueNumber: issue.number, ok: result.ok }));
    } catch (error) {
      const failure = githubBridgeFailure(issue?.number, error);
      if (failure.error.retryable) {
        logger.warn(JSON.stringify({ event: 'commander_github_task_retry', issueNumber: issue?.number, code: failure.error.code }));
        continue;
      }
      await finalizeIssue(github, issue.number, failure);
      completed += 1;
      logger.warn(JSON.stringify({ event: 'commander_github_task_rejected', issueNumber: issue.number, code: failure.error.code }));
    }
  }
  return { seen: issues.length, completed };
}

export function waitForNextPoll(ms, signal, schedule = setTimeout) {
  return new Promise((resolve) => {
    const timer = schedule(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export async function runGithubBridgeService(env = process.env, options = {}) {
  if (!enabled(env.COMMANDER_GITHUB_BRIDGE_ENABLED)) {
    options.logger?.info?.(JSON.stringify({ event: 'commander_github_bridge_disabled' }));
    return null;
  }
  const config = githubBridgeConfig(env);
  const logger = options.logger || console;
  const github = options.github || new CommanderGithubClient({ repository: config.repository, ghBin: config.ghBin });
  const client = options.client || commanderPublicClientFromEnv(env);
  await github.verifyLogin(config.allowedAuthor);
  const controller = options.controller || new AbortController();
  logger.info(JSON.stringify({ event: 'commander_github_bridge_started', repository: config.repository, label: config.taskLabel }));
  do {
    await runGithubBridgeCycle({ config, github, client, logger });
    if (options.once || controller.signal.aborted) break;
    await waitForNextPoll(config.pollMs, controller.signal);
  } while (!controller.signal.aborted);
  return { controller, config };
}

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await runGithubBridgeService(process.env, { controller });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'commander_github_bridge_fatal', error: String(error?.message || error) }));
    process.exitCode = 1;
  });
}
