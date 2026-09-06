import hashlib
import json


def _clip(value, limit=1000):
    return str(value or "")[:limit]


def _labels(items):
    values = []
    for item in list(items or [])[:32]:
        if isinstance(item, dict):
            value = item.get("name")
        else:
            value = item
        if value:
            values.append(_clip(value, 120))
    return sorted(set(values))


def github_observation(event_name: str, payload: dict) -> tuple[str, dict]:
    event = str(event_name or "").strip()
    if event == "workflow_run":
        run = payload.get("workflow_run") or {}
        workflow_id = str(run.get("workflow_id") or run.get("name") or "unknown")
        head_sha = _clip(run.get("head_sha"), 64) or "unknown"
        subject = f"workflow:{workflow_id}:{head_sha}"
        material = {
            "status": run.get("status"), "conclusion": run.get("conclusion"), "head_sha": head_sha,
            "run_number": run.get("run_number"), "run_attempt": run.get("run_attempt"),
            "event": run.get("event"), "branch": run.get("head_branch"),
        }
        summary = f"GitHub workflow {run.get('name') or workflow_id}: {run.get('status') or 'unknown'} / {run.get('conclusion') or 'pending'}"
        return subject, {"material": material, "summary": summary,
                         "metadata": {"githubEvent": event, "runId": run.get("id") or ""},
                         "evidence": [f"head_sha={head_sha}", f"conclusion={run.get('conclusion') or ''}"]}
    if event == "pull_request":
        pr = payload.get("pull_request") or {}
        number = int(payload.get("number") or pr.get("number") or 0)
        if number <= 0:
            raise ValueError("pull_request number missing")
        material = {
            "action": payload.get("action"), "state": pr.get("state"), "merged": bool(pr.get("merged")),
            "draft": bool(pr.get("draft")), "head_sha": (pr.get("head") or {}).get("sha"),
            "base_sha": (pr.get("base") or {}).get("sha"), "merge_commit_sha": pr.get("merge_commit_sha"),
        }
        return f"pr:{number}", {"material": material,
            "summary": f"GitHub PR #{number}: {payload.get('action') or pr.get('state') or 'changed'}",
            "metadata": {"githubEvent": event, "number": number},
            "evidence": [f"head_sha={material['head_sha'] or ''}", f"merged={material['merged']}"]}
    if event == "issues":
        issue = payload.get("issue") or {}
        number = int(issue.get("number") or 0)
        if number <= 0:
            raise ValueError("issue number missing")
        material = {"action": payload.get("action"), "state": issue.get("state"),
                    "state_reason": issue.get("state_reason"), "title": _clip(issue.get("title"), 500),
                    "labels": _labels(issue.get("labels"))}
        return f"issue:{number}", {"material": material,
            "summary": f"GitHub issue #{number}: {payload.get('action') or issue.get('state') or 'changed'}",
            "metadata": {"githubEvent": event, "number": number}, "evidence": []}
    if event == "issue_comment":
        issue = payload.get("issue") or {}; comment = payload.get("comment") or {}
        number = int(issue.get("number") or 0); comment_id = int(comment.get("id") or 0)
        if number <= 0 or comment_id <= 0:
            raise ValueError("issue_comment identity missing")
        body = str(comment.get("body") or "")
        material = {"action": payload.get("action"), "comment_id": comment_id,
                    "author": _clip((comment.get("user") or {}).get("login"), 120),
                    "body_sha256": hashlib.sha256(body.encode()).hexdigest()}
        return f"issue:{number}:comment:{comment_id}", {"material": material,
            "summary": f"GitHub issue #{number} comment {payload.get('action') or 'changed'}",
            "metadata": {"githubEvent": event, "number": number, "commentId": comment_id}, "evidence": []}
    raise ValueError(f"unsupported github event: {event}")


def runtime_observation(snapshot: dict) -> tuple[str, dict]:
    if not isinstance(snapshot, dict):
        raise ValueError("runtime snapshot must be an object")
    component = _clip(snapshot.get("component"), 120)
    if not component:
        raise ValueError("runtime component missing")
    material = {}
    for key in ("state", "status", "health", "version", "commit", "mode", "active", "ready", "error_code"):
        if key in snapshot:
            material[key] = snapshot[key]
    if isinstance(snapshot.get("flags"), dict):
        material["flags"] = {str(k)[:80]: bool(v) for k, v in list(snapshot["flags"].items())[:32]}
    if isinstance(snapshot.get("blockers"), list):
        material["blockers"] = [_clip(item, 500) for item in snapshot["blockers"][:20]]
    if not material:
        raise ValueError("runtime snapshot has no material health fields")
    status = material.get("status") or material.get("state") or material.get("health") or "changed"
    evidence = [_clip(item, 2000) for item in list(snapshot.get("safe_evidence") or [])[-12:]]
    return f"component:{component}", {"material": material, "summary": f"Runtime {component}: {status}",
                                      "metadata": {"component": component}, "evidence": evidence}
