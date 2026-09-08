#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import subprocess
import sys
from urllib.parse import urlsplit


def run(argv, *, input_text=None, check=True):
    result = subprocess.run(
        argv,
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()[:4000]
        raise RuntimeError(f"command_failed:{argv[0]}:{detail}")
    return result


def load_json(path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))


def load_secret(path):
    file_path = pathlib.Path(path)
    mode = file_path.stat().st_mode & 0o777
    if mode & 0o077:
        raise ValueError("secret_file_permissions_too_open")
    secret = file_path.read_text(encoding="utf-8").strip()
    if len(secret) < 32 or len(secret) > 256:
        raise ValueError("invalid_webhook_secret")
    return secret


def enabled_projects(config):
    projects = []
    for project in config.get("projects", []):
        github = project.get("github") or {}
        if project.get("enabled", True) is False or not github.get("repository"):
            continue
        projects.append({
            "id": project["id"],
            "repository": github["repository"],
            "taskLabels": github.get("taskLabels") or ["autopilot"],
        })
    return projects


def gh_json(argv):
    result = run(["gh", *argv])
    text = result.stdout.strip()
    return json.loads(text or "[]")


def existing_hooks(repository):
    return gh_json(["api", f"repos/{repository}/hooks", "--paginate"])


def labels(repository):
    data = gh_json(["label", "list", "-R", repository, "--limit", "100", "--json", "name"])
    return {item.get("name") for item in data if item.get("name")}


def desired_hook(callback_url, secret):
    return {
        "name": "web",
        "active": True,
        "events": ["issues"],
        "config": {
            "url": callback_url,
            "content_type": "json",
            "insecure_ssl": "0",
            "secret": secret,
        },
    }


def exact_hook(hooks, callback_url):
    for hook in hooks:
        if (hook.get("config") or {}).get("url") == callback_url:
            return hook
    return None


def print_report(report):
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))


def validate_public_target(base_url, public_path):
    parsed = urlsplit(base_url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("invalid_base_url")
    if not public_path.startswith("/") or ".." in public_path or "//" in public_path:
        raise ValueError("invalid_public_path")
    return base_url.rstrip("/") + public_path


def parser():
    p = argparse.ArgumentParser()
    p.add_argument("--config", default="config/v3-projects.json")
    p.add_argument("--secret-file", default="state-v3/github-webhook.secret")
    p.add_argument("--base-url", required=True)
    p.add_argument("--path", default="/autopilot-v3-github")
    p.add_argument("--service", default="chatgpt-autopilot-v3.service")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--rollback", action="store_true")
    return p


def main():
    args = parser().parse_args()
    callback_url = validate_public_target(args.base_url, args.path)
    config = load_json(args.config)
    projects = enabled_projects(config)
    if not projects:
        raise ValueError("no_github_projects")

    # Read-only discovery is always allowed; mutations require --apply.
    funnel = run(["tailscale", "funnel", "status", "--json"])
    json.loads(funnel.stdout or "{}")
    report = {
        "apply": bool(args.apply),
        "mode": "rollback" if args.rollback else "cutover",
        "callbackUrl": callback_url,
        "funnelPath": args.path,
        "funnelTarget": "http://127.0.0.1:8781/github",
        "projects": [],
        "service": args.service,
    }

    snapshots = []
    for project in projects:
        hooks = existing_hooks(project["repository"])
        found = exact_hook(hooks, callback_url)
        missing_labels = [] if args.rollback else [
            name for name in project["taskLabels"]
            if name not in labels(project["repository"])
        ]
        snapshots.append((project, found, missing_labels))
        report["projects"].append({
            "id": project["id"],
            "repository": project["repository"],
            "hookAction": ("delete" if found else "none") if args.rollback else ("update" if found else "create"),
            "hookId": found.get("id") if found else None,
            "missingLabels": missing_labels,
        })

    if not args.apply:
        print_report(report)
        return 0

    if args.rollback:
        for project, found, _ in snapshots:
            if found:
                run(["gh", "api", "--method", "DELETE", f"repos/{project['repository']}/hooks/{found['id']}"])
        run(["tailscale", "funnel", "--yes", f"--set-path={args.path}", "off"])
        run(["systemctl", "--user", "disable", "--now", args.service])
        report["applied"] = True
        print_report(report)
        return 0

    secret = load_secret(args.secret_file)
    run([
        "tailscale", "funnel", "--bg", "--yes",
        f"--set-path={args.path}",
        "http://127.0.0.1:8781/github",
    ])
    for project, found, missing_labels in snapshots:
        repository = project["repository"]
        for label in missing_labels:
            run(["gh", "label", "create", label, "-R", repository, "--color", "0E8A16",
                 "--description", "Handled by Autopilot v3"])
        payload = json.dumps(desired_hook(callback_url, secret), separators=(",", ":"))
        if found:
            run(["gh", "api", "--method", "PATCH", f"repos/{repository}/hooks/{found['id']}", "--input", "-"], input_text=payload)
        else:
            run(["gh", "api", "--method", "POST", f"repos/{repository}/hooks", "--input", "-"], input_text=payload)
    run(["systemctl", "--user", "enable", "--now", args.service])
    report["applied"] = True
    print_report(report)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)[:4000]}), file=sys.stderr)
        raise SystemExit(2)
