import argparse
import hashlib
import json
import time

from .ingress import ingest_observation
from .read_budget import RANGED_READ_MAX_WINDOWS, RANGED_READ_WINDOW_SECONDS, parse_ranged_read_target
from .read_tools import ReadActionError, load_tool_bindings
from .safe_tools import SafeToolExecutor
from .store import BrowserlessStore


def _subject(action):
    digest = hashlib.sha256(f"{action['type']}\0{action['target']}".encode()).hexdigest()[:24]
    return f"action:{action['type']}:{digest}"


def _suppression_subject(action):
    digest = hashlib.sha256(f"{action['type']}\0{action['target']}".encode()).hexdigest()[:24]
    return f"suppressed:{action['type']}:{digest}"


def _material_hash(material):
    encoded = json.dumps(material, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


LOCAL_ONLY_RESULT_KEYS = {"workspace", "workspace_path", "workspace_id", "local_path"}


def _context_material(value, depth=0):
    if depth > 5:
        return str(value)[:1000]
    if isinstance(value, dict):
        return {str(key)[:120]: _context_material(item, depth + 1)
                for key, item in list(value.items())[:64]
                if str(key).lower() not in LOCAL_ONLY_RESULT_KEYS}
    if isinstance(value, list):
        return [_context_material(item, depth + 1) for item in value[:64]]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:2000]


def execute_once(store, executor):
    action = store.claim_action()
    if not action:
        return {"status":"idle", "external_read":False}
    error_code = ""
    error_detail = ""
    performed_external_read = False
    ranged = parse_ranged_read_target(action["target"]) if action["type"] == "repo.read" else None
    streak = store.ranged_read_streak(action["project_id"], action["target"], action["id"], RANGED_READ_WINDOW_SECONDS) if ranged else 0
    if ranged and streak >= RANGED_READ_MAX_WINDOWS:
        error_code = "repo_ranged_read_budget_exhausted"
        result = {"ok":False, "error_code":error_code, "kind":action["type"], "target":action["target"],
                  "read_budget_exhausted":True, "blocked_file":ranged["file_key"],
                  "max_windows":RANGED_READ_MAX_WINDOWS, "window_seconds":RANGED_READ_WINDOW_SECONDS}
    else:
        try:
            result = executor.execute(action)
            performed_external_read = True
        except ReadActionError as exc:
            error_code = exc.code
            error_detail = getattr(exc, "detail", "")
            result = {"ok":False, "error_code":error_code, "kind":action["type"], "target":action["target"]}
            if error_detail:
                result["error_detail"] = error_detail
    material = _context_material(result)
    if error_code:
        failure_attempt = store.action_failure_count(action["project_id"], action["type"], action["target"], action["id"]) + 1
        material = {**material, "failure_attempt": failure_attempt, "retry_exhausted": failure_attempt >= 2}
    document = {"material":material,
                "summary":f"Safe evidence/workspace action {action['type']}: {'ok' if result.get('ok') else 'failed'}",
                "metadata":{"actionId":action["id"], "actionType":action["type"], "target":action["target"]},
                "evidence":[]}
    observation = ingest_observation(store, action["project_id"], "evidence", _subject(action), document)
    suppression = None
    if error_code:
        status = "failed"
    elif observation["changed"]:
        status = "done"
    else:
        status = "suppressed"
        suppression_document = {
            "material": {
                "suppressed_unchanged": True,
                "action_type": action["type"],
                "target": action["target"],
                "result_sha256": _material_hash(material),
            },
            "summary": "Unchanged evidence is already authoritative; do not repeat the same action target",
            "metadata": {"actionType": action["type"], "target": action["target"],
                         "reason": "unchanged_evidence_already_authoritative"},
            "evidence": [],
        }
        suppression = ingest_observation(store, action["project_id"], "evidence",
                                         _suppression_subject(action), suppression_document)
    store.finish_action(action["id"], status, result, error_code)
    event_created = observation["event_created"] if suppression is None else suppression["event_created"]
    return {"status":status, "external_read":performed_external_read, "action_id":action["id"],
            "evidence_changed":observation["changed"], "event_created":event_created,
            "suppression_event_created":bool(suppression and suppression["event_created"])}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Execute planned Browserless safe evidence/workspace actions")
    parser.add_argument("--db", required=True)
    parser.add_argument("--tools", required=True)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--idle-seconds", type=float, default=5.0)
    args = parser.parse_args(argv)
    store = BrowserlessStore(args.db)
    try:
        store.recover_running_actions()
        executor = SafeToolExecutor(load_tool_bindings(args.tools), store=store)
        while True:
            result = execute_once(store, executor)
            print(json.dumps(result, ensure_ascii=False), flush=True)
            if args.once: return 0
            if result["status"] == "idle": time.sleep(max(1.0, args.idle_seconds))
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
