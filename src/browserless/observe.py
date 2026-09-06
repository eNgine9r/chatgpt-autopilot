import argparse
import json
import sys
from pathlib import Path

from .ingress import ingest_observation
from .sources import github_observation, runtime_observation
from .store import BrowserlessStore


def _load(path):
    if path == "-":
        return json.load(sys.stdin)
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Normalize a read-only source snapshot into Browserless ingress")
    parser.add_argument("--db", required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--source", choices=["github", "runtime"], required=True)
    parser.add_argument("--github-event")
    parser.add_argument("--input", default="-")
    args = parser.parse_args(argv)
    raw = _load(args.input)
    if args.source == "github":
        if not args.github_event:
            parser.error("--github-event is required for github source")
        subject, document = github_observation(args.github_event, raw)
    else:
        subject, document = runtime_observation(raw)
    store = BrowserlessStore(args.db)
    try:
        result = ingest_observation(store, args.project_id, args.source, subject, document)
        result["counts"] = store.counts()
        print(json.dumps(result, ensure_ascii=False))
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
