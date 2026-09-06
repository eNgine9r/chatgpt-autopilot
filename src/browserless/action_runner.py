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


def execute_once(store, executor):
    action = store.claim_action()
    if not action:
        return {"status":"idle", "external_read":False}
    error_code = ""
    try:
        result = executor.execute(action)
    except ReadActionError as exc:
        error_code = exc.code
        result = {"ok":False, "error_code":error_code, "kind":action["type"], "target":action["target"]}
    document = {"material":result,
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
