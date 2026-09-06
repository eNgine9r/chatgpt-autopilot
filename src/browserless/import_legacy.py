import argparse
import json
from pathlib import Path

from .store import BrowserlessStore

PLAN_VERSION = "2026-09-04-v1"


def _load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _state_candidates(project_id, state_dirs):
    found = []
    for root in state_dirs:
        for candidate in (Path(root) / "projects" / f"{project_id}.json", Path(root) / f"{project_id}.json"):
            if not candidate.is_file():
                continue
            try:
                data = _load_json(candidate)
            except Exception:
                continue
            found.append((int(data.get("updatedAt") or 0), candidate, data))
    return sorted(found, key=lambda item: item[0], reverse=True)


def import_legacy(store, projects_config, state_dirs, selected_ids=None):
    document = _load_json(projects_config)
    selected = set(selected_ids or [])
    results = []
    for project in document.get("projects", []):
        project_id = str(project.get("id") or "")
        if selected and project_id not in selected:
            continue
        if project.get("backend", "browser") != "browser":
            continue
        anchor = str(project.get("planAnchor") or "")
        version = str(project.get("planVersion") or "")
        if not project_id or not anchor:
            continue
        if version != PLAN_VERSION:
            raise ValueError(f"{project_id}: unsupported plan version {version!r}")
        candidates = _state_candidates(project_id, state_dirs)
        state = candidates[0][2] if candidates else {}
        checkpoint = state.get("checkpoint") if isinstance(state.get("checkpoint"), dict) else {}
        store.register_project(project_id, version, anchor, checkpoint)
        results.append({
            "projectId": project_id,
            "legacyEnabled": project.get("enabled", True) is not False,
            "checkpointRevision": int(checkpoint.get("revision") or 0),
            "checkpointStage": str(checkpoint.get("stage") or "missing"),
            "stateUpdatedAt": int(state.get("updatedAt") or 0),
            "stateSource": str(candidates[0][1]) if candidates else "",
        })
    if selected - {item["projectId"] for item in results}:
        missing = sorted(selected - {item["projectId"] for item in results})
        raise ValueError(f"requested projects not importable: {','.join(missing)}")
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description="Import legacy Autopilot anchors/checkpoints into Browserless SQLite")
    parser.add_argument("--db", required=True)
    parser.add_argument("--projects-config", required=True)
    parser.add_argument("--state-dir", action="append", required=True)
    parser.add_argument("--project-id", action="append", default=[])
    args = parser.parse_args(argv)
    store = BrowserlessStore(args.db)
    try:
        results = import_legacy(store, args.projects_config, args.state_dir, args.project_id)
        print(json.dumps({"ok": True, "imported": results, "counts": store.counts()}, ensure_ascii=False))
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
