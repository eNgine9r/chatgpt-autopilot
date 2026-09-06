import argparse
import json
import time
from pathlib import Path

from .core import process_once
from .cost import BudgetGovernor
from .openai_client import LunaResponsesClient
from .store import BrowserlessStore


def load_projects(store, config_path):
    document = json.loads(Path(config_path).read_text(encoding="utf-8"))
    for project in document.get("projects", []):
        store.register_project(
            project["id"], project.get("planVersion", "2026-09-04-v1"),
            project["planAnchor"], project.get("checkpoint") or {})


def main(argv=None):
    parser = argparse.ArgumentParser(description="Luna-first Browserless Autopilot Core")
    parser.add_argument("--db", required=True)
    parser.add_argument("--config")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--idle-seconds", type=float, default=30.0)
    parser.add_argument("--hard-budget-usd", type=float, default=30.0)
    args = parser.parse_args(argv)

    store = BrowserlessStore(args.db)
    try:
        if args.config:
            load_projects(store, args.config)
        if not store.project_ids():
            parser.error("Browserless store has no projects; provide --config or import legacy state first")
        store.recover_running_jobs()
        client = LunaResponsesClient()
        governor = BudgetGovernor(hard_budget_usd=args.hard_budget_usd)
        while True:
            result = process_once(store, client, governor)
            print(json.dumps(result, ensure_ascii=False), flush=True)
            if args.once:
                return 0
            if result["status"] == "idle":
                time.sleep(max(1.0, args.idle_seconds))
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
