import argparse
import hashlib
import json
import time

from .ingress import ingest_observation
from .read_tools import ReadActionError, load_tool_bindings
from .safe_tools import SafeToolExecutor
from .store import BrowserlessStore


def _subject(action):
    digest = hashlib.sha256(f"{action['type']}\0{action['target']}".encode()).hexdigest()[:24]
    return f"action:{action['type']}:{digest}"


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
    try:
        result = executor.execute(action)
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
    if error_code:
        status = "failed"
    else:
        status = "done" if observation["changed"] else "suppressed"
    store.finish_action(action["id"], status, result, error_code)
    return {"status":status, "external_read":True, "action_id":action["id"],
            "evidence_changed":observation["changed"], "event_created":observation["event_created"]}


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
