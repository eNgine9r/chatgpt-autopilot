import argparse
import json
import threading
import time

from .action_runner import execute_once as execute_action_once
from .bootstrap import enqueue_checkpoint_bootstraps
from .core import process_once
from .cost import BudgetGovernor
from .ingress_server import create_server, load_bindings
from .openai_client import LunaResponsesClient
from .read_tools import capability_manifest, load_tool_bindings
from .safe_tools import SafeToolExecutor
from .store import BrowserlessStore


def run_once(store, client, executor, governor, capabilities_by_project=None, github_quiet_seconds=15):
    ai = process_once(store, client, governor, capabilities_by_project, github_quiet_seconds=github_quiet_seconds)
    action = execute_action_once(store, executor)
    return {"ai": ai, "action": action}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Single-process Browserless Autopilot supervisor")
    parser.add_argument("--db", required=True)
    parser.add_argument("--tools", required=True)
    parser.add_argument("--ingress-bindings")
    parser.add_argument("--ingress-host", default="127.0.0.1")
    parser.add_argument("--ingress-port", type=int, default=8771)
    parser.add_argument("--idle-seconds", type=float, default=5.0)
    parser.add_argument("--hard-budget-usd", type=float, default=30.0)
    parser.add_argument("--github-quiet-seconds", type=int, default=15)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)

    store = BrowserlessStore(args.db)
    server = None
    thread = None
    try:
        if not store.project_ids():
            parser.error("Browserless store has no projects; import legacy state first")
        store.recover_running_jobs()
        store.recover_running_actions()
        enqueue_checkpoint_bootstraps(store)
        client = LunaResponsesClient()
        governor = BudgetGovernor(hard_budget_usd=args.hard_budget_usd)
        tool_bindings = load_tool_bindings(args.tools)
        capabilities = capability_manifest(tool_bindings)
        executor = SafeToolExecutor(tool_bindings, store=store)
        if args.ingress_bindings:
            server = create_server(args.db, load_bindings(args.ingress_bindings), args.ingress_host, args.ingress_port)
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.5}, daemon=True)
            thread.start()
        while True:
            result = run_once(store, client, executor, governor, capabilities, args.github_quiet_seconds)
            print(json.dumps(result, ensure_ascii=False), flush=True)
            if args.once:
                return 0
            ai_idle = result["ai"].get("status") == "idle"
            action_idle = result["action"].get("status") == "idle"
            if ai_idle and action_idle:
                time.sleep(max(1.0, args.idle_seconds))
    finally:
        if server:
            server.shutdown()
            server.server_close()
        if thread and thread.is_alive():
            thread.join(timeout=2)
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
