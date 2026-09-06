import hashlib
import json


CHECKPOINT_SCALARS = ("goal", "currentTask", "nextAction", "planVersion", "stage", "githubPr")
CHECKPOINT_LISTS = ("completed", "decisions", "evidence", "blockers", "doNotRepeat")


def _fingerprint(checkpoint):
    source = checkpoint if isinstance(checkpoint, dict) else {}
    governed = {key: source.get(key, "" if key != "githubPr" else 0) for key in CHECKPOINT_SCALARS}
    for key in CHECKPOINT_LISTS:
        governed[key] = list(source.get(key) or [])
    raw = json.dumps(governed, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def enqueue_checkpoint_bootstraps(store):
    results = []
    for project_id in store.project_ids():
        project = store.project(project_id)
        checkpoint = project.get("checkpoint") if isinstance(project.get("checkpoint"), dict) else {}
        if checkpoint.get("stage") != "active":
            continue
        current_task = str(checkpoint.get("currentTask") or "").strip()
        next_action = str(checkpoint.get("nextAction") or "").strip()
        if not current_task and not next_action:
            continue
        digest = _fingerprint(checkpoint)
        key = f"bootstrap:{project_id}:{digest}"
        inserted = store.enqueue_event(project_id, key, "bootstrap.resume", {
            "summary": f"Resume durable checkpoint: {current_task or next_action}"[:4000],
            "metadata": {"source": "checkpoint", "checkpointRevision": int(checkpoint.get("revision") or 0)},
            "material": {"currentTask": current_task, "nextAction": next_action, "checkpointHash": digest},
            "evidence": [],
        })
        results.append({"project_id": project_id, "event_key": key, "inserted": inserted})
    return results
