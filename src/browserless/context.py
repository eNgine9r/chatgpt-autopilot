import json

MAX_EVIDENCE_ITEMS = 12
MAX_EVIDENCE_CHARS = 12000
MAX_SUMMARY_CHARS = 4000
MAX_CHECKPOINT_LIST = 20


def _clip(value, limit=1000):
    return str(value or "")[:limit]


def _bounded_evidence(items):
    result, used = [], 0
    for item in list(items or [])[-MAX_EVIDENCE_ITEMS:]:
        text = _clip(item, 2000)
        if used + len(text) > MAX_EVIDENCE_CHARS:
            break
        result.append(text)
        used += len(text)
    return result


def _bounded_checkpoint(checkpoint):
    source = checkpoint if isinstance(checkpoint, dict) else {}
    scalar = ["goal", "currentTask", "nextAction", "planVersion", "stage", "githubPr"]
    result = {key: source.get(key, "" if key != "githubPr" else 0) for key in scalar}
    for key in ["completed", "decisions", "evidence", "blockers", "doNotRepeat"]:
        result[key] = [_clip(item) for item in list(source.get(key) or [])[-MAX_CHECKPOINT_LIST:]]
    return result


def _bounded_metadata(value):
    if not isinstance(value, dict):
        return {}
    return {str(k)[:80]: _clip(v, 500) for k, v in list(value.items())[:20]}



def _bounded_material(value, depth=0):
    if depth > 3:
        return _clip(value, 500)
    if isinstance(value, dict):
        return {str(k)[:80]: _bounded_material(v, depth + 1) for k, v in list(value.items())[:32]}
    if isinstance(value, list):
        return [_bounded_material(item, depth + 1) for item in value[:32]]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return _clip(value, 1000)


def compile_context(project: dict, event: dict) -> str:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    stable = {
        "planVersion": project["plan_version"],
        "planAnchor": _clip(project["plan_anchor"], 12000),
        "policy": {"model": "gpt-5.6-luna", "noSilentModelEscalation": True,
                   "noTradingOrHardwareWrites": True, "failClosedOnAmbiguity": True},
    }
    fresh = {
        "projectId": project["id"],
        "checkpoint": _bounded_checkpoint(project.get("checkpoint")),
        "event": {"kind": _clip(event["kind"], 128), "summary": _clip(payload.get("summary"), MAX_SUMMARY_CHARS),
                  "metadata": _bounded_metadata(payload.get("metadata")),
                  "material": _bounded_material(payload.get("material"))},
        "evidence": _bounded_evidence(payload.get("evidence")),
    }
    return "STABLE_CONTEXT\n" + json.dumps(stable, ensure_ascii=False, separators=(",", ":")) + "\nFRESH_CONTEXT\n" + json.dumps(fresh, ensure_ascii=False, separators=(",", ":"))
