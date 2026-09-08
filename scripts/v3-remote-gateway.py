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
