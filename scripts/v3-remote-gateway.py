#!/usr/bin/env python3
import json
import os
import pathlib
import re
import subprocess
import sys

MAX_OUTPUT = 12000
ALLOWED_COMMANDS = {
    "python3", "pytest", "uv", "npm", "node", "pnpm", "yarn", "cargo", "go", "make"
}


def bounded(value, limit=MAX_OUTPUT):
    text = str(value or "")
    if len(text) <= limit:
        return text
    return text[:limit] + "\n...[truncated]"


def clean_env():
    env = {"CI": "1"}
    for name in ("PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR"):
        if os.environ.get(name):
            env[name] = os.environ[name]
    return env


def load_config():
    path = pathlib.Path(os.environ.get(
        "AUTOPILOT_V3_REMOTE_CONFIG",
        "~/.config/chatgpt-autopilot-v3/remote.json",
    )).expanduser()
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version") != 3:
        raise ValueError("invalid_remote_config")
    repo = pathlib.Path(str(data.get("repoPath", "")))
    if not repo.is_absolute():
        raise ValueError("invalid_repo_path")
    return data, repo


def run(argv, repo, timeout_ms):
    if not argv or argv[0] not in ALLOWED_COMMANDS | {"git"}:
        raise ValueError("command_not_allowed")
    try:
        result = subprocess.run(
            argv,
            cwd=repo,
            env=clean_env(),
            timeout=max(0.1, timeout_ms / 1000),
            capture_output=True,
            text=True,
            shell=False,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"command_timeout:{bounded(exc.stderr or exc.stdout, 4000)}") from exc
    if result.returncode != 0:
        raise RuntimeError(f"command_failed:{bounded(result.stderr or result.stdout, 4000)}")
    return result


def inspect_repo(repo):
    head = run(["git", "rev-parse", "--verify", "HEAD"], repo, 15000).stdout.strip()
    branch = run(["git", "branch", "--show-current"], repo, 15000).stdout.strip()
    status = run(["git", "status", "--porcelain=v1", "--untracked-files=no"], repo, 15000).stdout
    return {
        "head": head,
        "branch": branch,
        "cleanTracked": not status.strip(),
        "trackedStatus": bounded(status, 4000),
    }


def issue_from_branch(branch):
    match = re.search(r"(?:^|/)(\d+)(?:[-_/]|$)", branch)
    return int(match.group(1)) if match else None


def publish_tracked(config, repo, expected_head, expected_branch):
    if config.get("publishEnabled") is not True:
        raise ValueError("publish_disabled")
    if not re.fullmatch(r"[0-9a-f]{40}", expected_head or "", re.IGNORECASE):
        raise ValueError("invalid_expected_head")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,159}", expected_branch or ""):
        raise ValueError("invalid_expected_branch")
    run(["git", "check-ref-format", "--branch", expected_branch], repo, 15000)
    current = run(["git", "rev-parse", "HEAD"], repo, 15000).stdout.strip()
    if current.lower() != expected_head.lower():
        raise ValueError("publish_head_mismatch")
    branch = run(["git", "branch", "--show-current"], repo, 15000).stdout.strip()
    if branch != expected_branch or branch in {"main", "master"}:
        raise ValueError("publish_branch_mismatch")
    staged = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=repo, env=clean_env(), check=False).returncode
    if staged != 0:
        raise ValueError("publish_index_not_clean")
    status_all = run(["git", "status", "--porcelain=v1", "--untracked-files=all"], repo, 15000).stdout.splitlines()
    untracked = [line[3:] for line in status_all if line.startswith("?? ")]
    allowed_untracked = ("__pycache__/", ".pyc", ".pyo", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/")
    for item in untracked:
        if not (any(part == "__pycache__" for part in pathlib.PurePosixPath(item).parts) or item.endswith((".pyc", ".pyo")) or item.startswith(allowed_untracked)):
            raise ValueError("publish_untracked_source")
    changed = run(["git", "diff", "--name-only", "HEAD"], repo, 15000).stdout.splitlines()
    changed = [item for item in changed if item]
    if not changed or len(changed) > 100:
        raise ValueError("publish_changed_files_invalid")
    denied = tuple(str(x) for x in (config.get("publishDeniedPrefixes") or [".env", "runtime/", ".git/"]))
    if any(path.startswith(denied) for path in changed):
        raise ValueError("publish_denied_path")
    run(["git", "diff", "--check"], repo, 15000)
    run(["git", "add", "-u", "--", *changed], repo, 15000)
    issue = issue_from_branch(branch)
    message = f"autopilot: progress issue #{issue}" if issue else "autopilot: publish verified tracked changes"
    try:
        run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", message], repo, 30000)
        commit = run(["git", "rev-parse", "HEAD"], repo, 15000).stdout.strip()
        run(["git", "push", "origin", f"HEAD:refs/heads/{branch}"], repo, 60000)
    except Exception:
        subprocess.run(["git", "reset", "--mixed", "HEAD"], cwd=repo, env=clean_env(), check=False, capture_output=True, text=True)
        raise
    return {"ok": True, "branch": branch, "issue": issue, "commit": commit, "files": changed}


def run_test(config, repo, alias):
    if not re.fullmatch(r"[A-Za-z0-9._-]+", alias or ""):
        raise ValueError("invalid_test_alias")
    spec = (config.get("tests") or {}).get(alias)
    if not isinstance(spec, dict):
        raise ValueError("unknown_test_alias")
    command = str(spec.get("command", ""))
    args = spec.get("args")
    if command not in ALLOWED_COMMANDS or not isinstance(args, list):
        raise ValueError("invalid_test_spec")
    if any(not isinstance(item, str) or "\x00" in item for item in args):
        raise ValueError("invalid_test_args")
    timeout_ms = int(spec.get("timeoutMs", 600000))
    if timeout_ms < 100 or timeout_ms > 1800000:
        raise ValueError("invalid_test_timeout")
    result = run([command, *args], repo, timeout_ms)
    return {
        "alias": alias,
        "exitCode": 0,
        "stdout": bounded(result.stdout),
        "stderr": bounded(result.stderr),
    }


def main():
    command = os.environ.get("SSH_ORIGINAL_COMMAND", "").strip()
    config, repo = load_config()
    if command == "inspect":
        output = inspect_repo(repo)
    elif command.startswith("test "):
        output = run_test(config, repo, command[5:])
    elif command.startswith("publish "):
        parts = command.split(" ")
        if len(parts) != 3:
            raise ValueError("invalid_publish_operation")
        output = publish_tracked(config, repo, parts[1], parts[2])
    else:
        raise ValueError("unsupported_operation")
    print(json.dumps(output, separators=(",", ":"), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        message = bounded(str(exc), 4000)
        print(json.dumps({"ok": False, "error": message}, separators=(",", ":")), file=sys.stderr)
        raise SystemExit(64)
