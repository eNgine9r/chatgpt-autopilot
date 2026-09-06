import argparse
import json
from .store import BrowserlessStore


def main(argv=None):
    parser = argparse.ArgumentParser(description="Enqueue one Browserless Autopilot event")
    parser.add_argument("--db", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--kind", required=True)
    parser.add_argument("--payload", default="{}")
    args = parser.parse_args(argv)
    store = BrowserlessStore(args.db)
    try:
        inserted = store.enqueue_event(args.project, args.key, args.kind, json.loads(args.payload))
        print(json.dumps({"ok": True, "inserted": inserted}))
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
