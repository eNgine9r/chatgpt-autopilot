import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

from .store import BrowserlessStore

ALLOWED_SOURCES = {"github", "runtime", "git", "operator", "scheduler"}
VOLATILE_KEYS = {
    "timestamp", "time", "observedat", "observed_at", "checkedat", "checked_at",
    "generatedat", "generated_at", "fetchedat", "fetched_at", "lastseenat", "last_seen_at",
    "updatedat", "updated_at", "latency", "latency_ms", "duration", "duration_ms", "uptime", "uptime_seconds",
}
TOKEN = re.compile(r"^[A-Za-z0-9_.:/-]{1,180}$")
MAX_MATERIAL_CHARS = 32000


def _normalize(value, depth=0):
    if depth > 4:
        return str(value)[:1000]
    if isinstance(value, dict):
        out = {}
        for key in sorted(value, key=lambda item: str(item))[:64]:
            name = str(key)[:120]
            if name.lower() in VOLATILE_KEYS or name.startswith("_"):
                continue
            out[name] = _normalize(value[key], depth + 1)
        return out
    if isinstance(value, list):
        items = [_normalize(item, depth + 1) for item in value[:64]]
        return sorted(items, key=lambda item: json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:2000]


def canonical_material(material):
    if not isinstance(material, dict):
        raise ValueError("material must be an object")
    normalized = _normalize(material)
    encoded = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if len(encoded) > MAX_MATERIAL_CHARS:
        raise ValueError("material exceeds bounded ingress size")
    return normalized, hashlib.sha256(encoded.encode()).hexdigest()


def _bounded_payload(document):
    summary = str(document.get("summary") or "")[:4000]
    metadata = document.get("metadata") if isinstance(document.get("metadata"), dict) else {}
    metadata = {str(k)[:80]: str(v)[:500] for k, v in list(metadata.items())[:20]}
    evidence = [str(item)[:2000] for item in list(document.get("evidence") or [])[-12:]]
    return {"summary": summary, "metadata": metadata, "evidence": evidence}


def ingest_observation(store, project_id: str, source: str, subject: str, document: dict) -> dict:
    if source not in ALLOWED_SOURCES:
        raise ValueError(f"unsupported ingress source: {source}")
    if not TOKEN.fullmatch(subject or ""):
        raise ValueError("invalid observation subject")
    store.project(project_id)  # fail closed on unknown project
    material, content_hash = canonical_material(document.get("material"))
    result = store.record_observation(project_id, source, subject, content_hash, material, _bounded_payload(document))
    return {"ok": True, "projectId": project_id, "source": source, "subject": subject,
            "contentHash": content_hash, **result}


def _read_document(path):
    if path == "-":
        return json.load(sys.stdin)
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Ingest one bounded Browserless observation without polling")
    parser.add_argument("--db", required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--source", required=True, choices=sorted(ALLOWED_SOURCES))
    parser.add_argument("--subject", required=True)
    parser.add_argument("--input", default="-", help="JSON observation envelope or - for stdin")
    args = parser.parse_args(argv)
    store = BrowserlessStore(args.db)
    try:
        result = ingest_observation(store, args.project_id, args.source, args.subject, _read_document(args.input))
        result["counts"] = store.counts()
        print(json.dumps(result, ensure_ascii=False))
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
