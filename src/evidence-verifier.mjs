import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function run(file, args, options = {}) {
  const { stdout = "" } = await execFileAsync(file, args, {
    cwd: options.cwd,
    timeout: options.timeout ?? 5000,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
  return String(stdout).trim();
}

export function evidenceConfigured(policy = {}) {
  const local = policy.repoPath && (policy.requireCleanWorktree || policy.requireHeadAdvanceFrom);
  const github = policy.github?.requireMergedPr && policy.github?.repository;
  return Boolean(local || github);
}

export async function verifyProjectEvidence(project, checkpoint, { runCommand = run } = {}) {
  const policy = project.checkpointLedger?.evidence || {};
  const result = {
    configured: evidenceConfigured(policy), ok: false, checkedAt: Date.now(), reasons: [], localGit: null, github: null
  };
  let localHead = "";
  if (policy.repoPath) {
    const local = { configured: true, ok: true, head: "", branch: "", clean: null, advanced: null, error: "" };
    try {
      local.head = await runCommand("git", ["-C", policy.repoPath, "rev-parse", "HEAD"]);
      local.branch = await runCommand("git", ["-C", policy.repoPath, "branch", "--show-current"]);
      localHead = local.head;
      const porcelain = await runCommand("git", ["-C", policy.repoPath, "status", "--porcelain"]);
      local.clean = porcelain.length === 0;
      if (policy.requireCleanWorktree && !local.clean) {
        local.ok = false;
        result.reasons.push("worktree_dirty");
      }
      if (policy.requireHeadAdvanceFrom) {
        local.advanced = false;
        if (local.head !== policy.requireHeadAdvanceFrom) {
          try {
            await runCommand("git", ["-C", policy.repoPath, "merge-base", "--is-ancestor", policy.requireHeadAdvanceFrom, local.head]);
            local.advanced = true;
          } catch {
            local.advanced = false;
          }
        }
        if (!local.advanced) {
          local.ok = false;
          result.reasons.push("head_not_advanced");
        }
      }
    } catch (error) {
      local.ok = false;
      local.error = String(error?.message || error).slice(0, 500);
      result.reasons.push("local_git_unavailable");
    }
    result.localGit = local;
  }
  const gh = policy.github || {};
  if (gh.repository && gh.requireMergedPr) {
    const github = { configured: true, ok: false, pr: Number(checkpoint.githubPr || 0), state: "", mergedAt: "", mergeCommit: "", error: "" };
    if (!github.pr) {
      result.reasons.push("github_pr_missing");
    } else {
      try {
        const raw = await runCommand("gh", ["pr", "view", String(github.pr), "--repo", gh.repository, "--json", "state,mergedAt,mergeCommit,headRefOid"]);
        const parsed = JSON.parse(raw || "{}");
        github.state = String(parsed.state || "");
        github.mergedAt = String(parsed.mergedAt || "");
        github.mergeCommit = String(parsed.mergeCommit?.oid || "");
        github.ok = github.state === "MERGED" || Boolean(github.mergedAt);
        if (!github.ok) result.reasons.push("github_pr_not_merged");
        if (github.ok && gh.matchLocalHead && localHead) {
          const candidates = [github.mergeCommit, String(parsed.headRefOid || "")].filter(Boolean);
          if (!candidates.includes(localHead)) {
            github.ok = false;
            result.reasons.push("github_head_mismatch");
          }
        }
      } catch (error) {
        github.error = String(error?.message || error).slice(0, 500);
        result.reasons.push("github_evidence_unavailable");
      }
    }
    result.github = github;
  }

  if (!result.configured) {
    result.reasons.push("no_completion_requirement_configured");
    return result;
  }
  const checks = [result.localGit, result.github].filter((item) => item?.configured);
  result.ok = checks.length > 0 && checks.every((item) => item.ok);
  return result;
}