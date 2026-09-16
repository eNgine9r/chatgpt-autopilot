import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export class CommanderGithubClient {
  constructor({ repository, ghBin = '/usr/bin/gh', timeoutMs = 15_000, runner = execFileAsync } = {}) {
    if (typeof repository !== 'string' || !REPOSITORY.test(repository)) throw new Error('invalid_github_bridge_repository');
    if (typeof ghBin !== 'string' || !ghBin.startsWith('/')) throw new Error('invalid_github_bridge_gh_bin');
    this.repository = repository;
    this.ghBin = ghBin;
    this.timeoutMs = timeoutMs;
    this.runner = runner;
  }

  async #run(args) {
    const { stdout } = await this.runner(this.ghBin, args, {
      encoding: 'utf8', timeout: this.timeoutMs, maxBuffer: 512 * 1024,
      env: process.env,
    });
    return String(stdout || '');
  }

  async verifyLogin(expectedLogin) {
    const login = (await this.#run(['api', 'user', '--jq', '.login'])).trim();
    if (login !== expectedLogin) throw new Error('github_bridge_login_mismatch');
    return login;
  }

  async listOpenTasks(label, limit = 10) {
    if (typeof label !== 'string' || !label || label.length > 100) throw new Error('invalid_github_bridge_label');
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid_github_bridge_limit');
    const endpoint = `repos/${this.repository}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=${limit}&sort=created&direction=asc`;
    const text = await this.#run(['api', endpoint]);
    const issues = JSON.parse(text || '[]');
    if (!Array.isArray(issues)) throw new Error('invalid_github_issue_response');
    return issues.slice(0, limit);
  }

  async addComment(issueNumber, body) {
    if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('invalid_github_issue_number');
    await this.#run([
      'api', '--method', 'POST', `repos/${this.repository}/issues/${issueNumber}/comments`,
      '-f', `body=${body}`,
    ]);
  }

  async closeIssue(issueNumber) {
    if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('invalid_github_issue_number');
    await this.#run([
      'api', '--method', 'PATCH', `repos/${this.repository}/issues/${issueNumber}`,
      '-f', 'state=closed',
    ]);
  }
}
