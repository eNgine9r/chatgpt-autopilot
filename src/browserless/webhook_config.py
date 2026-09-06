import argparse
import json
import os
import re
import stat
import subprocess
from pathlib import Path
from urllib.parse import urlparse

PROJECT = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
EVENTS = ["workflow_run", "pull_request", "issues", "issue_comment"]


class WebhookConfigError(RuntimeError):
    pass


def normalize_base_url(value: str) -> str:
    url = urlparse(str(value or ""))
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise WebhookConfigError("invalid_base_url")
    return str(value).rstrip("/")


def load_plan(bindings_path, base_url):
    base = normalize_base_url(base_url)
    doc = json.loads(Path(bindings_path).read_text(encoding="utf-8"))
    result = []
    for project_id, raw in sorted((doc.get("github") or {}).items()):
        project_id = str(project_id)
        repo = str((raw or {}).get("repository") or "")
        secret_env = str((raw or {}).get("secretEnv") or "")
        if not PROJECT.fullmatch(project_id) or not REPO.fullmatch(repo) or not PROJECT.fullmatch(secret_env):
            raise WebhookConfigError(f"invalid_binding:{project_id}")
        result.append({"project_id": project_id, "repository": repo, "secret_env": secret_env,
                       "callback": f"{base}/v1/github/{project_id}"})
    return result


def _load_env_file(path):
    p = Path(path)
    mode = stat.S_IMODE(p.stat().st_mode)
    if mode & 0o077:
        raise WebhookConfigError("env_file_permissions_too_open")
    values = {}
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip(); value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        values[key] = value
    return values


def _gh_json(args, body=None, runner=subprocess.run):
    command = ["gh", "api", *args]
    result = runner(command, input=None if body is None else json.dumps(body), text=True,
                    capture_output=True, check=False)
    if result.returncode != 0:
        raise WebhookConfigError("gh_api_failed")
    if not result.stdout.strip():
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise WebhookConfigError("gh_api_invalid_json") from exc


def reconcile(plan, env_file, runner=subprocess.run):
    env = _load_env_file(env_file)
    results = []
    for item in plan:
        secret = env.get(item["secret_env"], "")
        if len(secret) < 32:
            raise WebhookConfigError(f"missing_or_short_secret:{item['secret_env']}")
        hooks = _gh_json([f"repos/{item['repository']}/hooks"], runner=runner) or []
        matches = [hook for hook in hooks if str((hook.get("config") or {}).get("url") or "") == item["callback"]]
        if len(matches) > 1:
            raise WebhookConfigError(f"duplicate_webhook:{item['repository']}")
        config = {"url": item["callback"], "content_type": "json", "secret": secret, "insecure_ssl": "0"}
        if matches:
            hook_id = int(matches[0]["id"])
            body = {"active": True, "events": EVENTS, "config": config}
            response = _gh_json(["--method", "PATCH", f"repos/{item['repository']}/hooks/{hook_id}", "--input", "-"], body, runner)
            action = "updated"
        else:
            body = {"name": "web", "active": True, "events": EVENTS, "config": config}
            response = _gh_json(["--method", "POST", f"repos/{item['repository']}/hooks", "--input", "-"], body, runner)
            hook_id = int((response or {}).get("id") or 0)
            action = "created"
        results.append({"project_id": item["project_id"], "repository": item["repository"],
                        "callback": item["callback"], "action": action, "hook_id": hook_id})
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description="Dry-run-first GitHub webhook configurator for Browserless Autopilot")
    parser.add_argument("--bindings", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--env-file", default=".env.local")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    plan = load_plan(args.bindings, args.base_url)
    if not args.apply:
        print(json.dumps({"ok": True, "mode": "dry-run", "hooks": [
            {"project_id": x["project_id"], "repository": x["repository"], "callback": x["callback"], "events": EVENTS}
            for x in plan]}, ensure_ascii=False))
        return 0
    auth = subprocess.run(["gh", "auth", "status"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if auth.returncode != 0:
        raise WebhookConfigError("gh_not_authenticated")
    results = reconcile(plan, args.env_file)
    print(json.dumps({"ok": True, "mode": "apply", "hooks": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
