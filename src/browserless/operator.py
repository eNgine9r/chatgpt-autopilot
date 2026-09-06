import argparse
import hashlib
import json
import re
import sys

from .store import BrowserlessStore

REQUEST_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")
MAX_TASK_CHARS = 4000


def enqueue_operator_task(store, project_id, task, request_id=""):
    store.project(project_id)
    text = str(task or "").strip()
    if not text or len(text) > MAX_TASK_CHARS:
        raise ValueError("invalid_operator_task")
    rid = str(request_id or "").strip() or hashlib.sha256(text.encode()).hexdigest()[:24]
    if not REQUEST_ID.fullmatch(rid):
        raise ValueError("invalid_request_id")
    inserted = store.enqueue_event(project_id, f"operator:{project_id}:{rid}", "operator.task", {
        "summary": text,
        "metadata": {"source": "operator", "requestId": rid},
        "material": {"task": text},
        "evidence": [],
    })
    return {"inserted": inserted, "project_id": project_id, "request_id": rid}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Submit one Browserless operator task without Chromium")
    parser.add_argument("--db", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--request-id", default="")
    parser.add_argument("--task")
    args = parser.parse_args(argv)
    task = args.task if args.task is not None else sys.stdin.read()
    store = BrowserlessStore(args.db)
    try:
        result = enqueue_operator_task(store, args.project, task, args.request_id)
        print(json.dumps({"ok": True, **result}, ensure_ascii=False))
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
