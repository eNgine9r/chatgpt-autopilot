import calendar
import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path


class BrowserlessStore:
    def __init__(self, path: str):
        self.path = str(Path(path))
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self._schema()
        self._enforce_private_file_modes()

    def _enforce_private_file_modes(self):
        for candidate in (Path(self.path), Path(self.path + "-wal"), Path(self.path + "-shm")):
            try:
                candidate.chmod(0o600)
            except FileNotFoundError:
                pass

    def close(self):
        self._enforce_private_file_modes()
        self.db.close()

    def _schema(self):
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS projects(
          id TEXT PRIMARY KEY, plan_version TEXT NOT NULL, plan_anchor TEXT NOT NULL,
          checkpoint_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS events(
          id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL,
          payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs(
          id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER UNIQUE NOT NULL REFERENCES events(id),
          project_id TEXT NOT NULL REFERENCES projects(id), status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0, decision_json TEXT NOT NULL DEFAULT '{}',
          last_error TEXT NOT NULL DEFAULT '', available_at INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS observations(
          project_id TEXT NOT NULL REFERENCES projects(id), source TEXT NOT NULL, subject TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0, content_hash TEXT NOT NULL, material_json TEXT NOT NULL,
          last_seen_at INTEGER NOT NULL, changed_at INTEGER NOT NULL,
          PRIMARY KEY(project_id,source,subject));
        CREATE TABLE IF NOT EXISTS action_requests(
          id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL REFERENCES jobs(id),
          project_id TEXT NOT NULL REFERENCES projects(id), sequence INTEGER NOT NULL,
          action_type TEXT NOT NULL, target TEXT NOT NULL, purpose TEXT NOT NULL, payload_text TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'planned', result_json TEXT NOT NULL DEFAULT '{}',
          last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0,
          UNIQUE(job_id,sequence));
        CREATE TABLE IF NOT EXISTS usage(
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
          response_id TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, input_tokens INTEGER NOT NULL,
          cached_input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
          cost_usd REAL NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS repo_workspaces(
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
          alias TEXT NOT NULL, branch TEXT NOT NULL, workspace_path TEXT NOT NULL, base_sha TEXT NOT NULL,
          diff_sha TEXT NOT NULL DEFAULT '', last_test_sha TEXT NOT NULL DEFAULT '', last_test_passed INTEGER NOT NULL DEFAULT 0,
          test_attestations_json TEXT NOT NULL DEFAULT '{}',
          commit_sha TEXT NOT NULL DEFAULT '', pr_number INTEGER NOT NULL DEFAULT 0, pr_url TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_workspaces_active
          ON repo_workspaces(project_id,alias) WHERE status='active';
        CREATE INDEX IF NOT EXISTS idx_events_status ON events(status,id);
        CREATE INDEX IF NOT EXISTS idx_jobs_status_project ON jobs(status,project_id,id);
        CREATE INDEX IF NOT EXISTS idx_usage_created ON usage(created_at);
        """)
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(jobs)")}
        if "available_at" not in columns:
            self.db.execute("ALTER TABLE jobs ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0")
        action_columns = {row[1] for row in self.db.execute("PRAGMA table_info(action_requests)")}
        if "result_json" not in action_columns:
            self.db.execute("ALTER TABLE action_requests ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}'")
        if "last_error" not in action_columns:
            self.db.execute("ALTER TABLE action_requests ADD COLUMN last_error TEXT NOT NULL DEFAULT ''")
        if "updated_at" not in action_columns:
            self.db.execute("ALTER TABLE action_requests ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0")
        if "payload_text" not in action_columns:
            self.db.execute("ALTER TABLE action_requests ADD COLUMN payload_text TEXT NOT NULL DEFAULT ''")
        workspace_columns = {row[1] for row in self.db.execute("PRAGMA table_info(repo_workspaces)")}
        if "diff_sha" not in workspace_columns:
            self.db.execute("ALTER TABLE repo_workspaces ADD COLUMN diff_sha TEXT NOT NULL DEFAULT ''")
        if "last_test_sha" not in workspace_columns:
            self.db.execute("ALTER TABLE repo_workspaces ADD COLUMN last_test_sha TEXT NOT NULL DEFAULT ''")
        if "last_test_passed" not in workspace_columns:
            self.db.execute("ALTER TABLE repo_workspaces ADD COLUMN last_test_passed INTEGER NOT NULL DEFAULT 0")
        if "test_attestations_json" not in workspace_columns:
            self.db.execute("ALTER TABLE repo_workspaces ADD COLUMN test_attestations_json TEXT NOT NULL DEFAULT '{}'")
        if "commit_sha" not in workspace_columns:
            self.db.execute("ALTER TABLE repo_workspaces ADD COLUMN commit_sha TEXT NOT NULL DEFAULT ''")
        if "pr_number" not in workspace_columns:
            self.db.execute("ALTER TABLE repo_workspaces ADD COLUMN pr_number INTEGER NOT NULL DEFAULT 0")
        if "pr_url" not in workspace_columns:
            self.db.execute("ALTER TABLE repo_workspaces ADD COLUMN pr_url TEXT NOT NULL DEFAULT ''")

    @staticmethod
    def _now():
        return int(time.time())

    def register_project(self, project_id: str, plan_version: str, plan_anchor: str, checkpoint=None):
        now = self._now()
        self.db.execute("""INSERT INTO projects(id,plan_version,plan_anchor,checkpoint_json,updated_at)
          VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET plan_version=excluded.plan_version,
          plan_anchor=excluded.plan_anchor, updated_at=excluded.updated_at""",
          (project_id, plan_version, plan_anchor, json.dumps(checkpoint or {}, ensure_ascii=False), now))

    def project(self, project_id: str) -> dict:
        row = self.db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not row:
            raise KeyError(project_id)
        return {"id": row["id"], "plan_version": row["plan_version"], "plan_anchor": row["plan_anchor"],
                "checkpoint": json.loads(row["checkpoint_json"] or "{}")}

    def enqueue_event(self, project_id: str, event_key: str, kind: str, payload=None) -> bool:
        try:
            self.db.execute("INSERT INTO events(event_key,project_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)",
                            (event_key, project_id, kind, json.dumps(payload or {}, ensure_ascii=False), self._now()))
            return True
        except sqlite3.IntegrityError:
            return False


    def record_observation(self, project_id: str, source: str, subject: str, content_hash: str, material, payload) -> dict:
        now = self._now()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            current = self.db.execute(
                "SELECT revision,content_hash FROM observations WHERE project_id=? AND source=? AND subject=?",
                (project_id, source, subject),
            ).fetchone()
            if current and current["content_hash"] == content_hash:
                self.db.execute(
                    "UPDATE observations SET last_seen_at=? WHERE project_id=? AND source=? AND subject=?",
                    (now, project_id, source, subject),
                )
                self.db.execute("COMMIT")
                return {"changed": False, "revision": int(current["revision"]), "event_created": False}
            revision = int(current["revision"] if current else 0) + 1
            self.db.execute(
                """INSERT INTO observations(project_id,source,subject,revision,content_hash,material_json,last_seen_at,changed_at)
                VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,source,subject) DO UPDATE SET
                revision=excluded.revision,content_hash=excluded.content_hash,material_json=excluded.material_json,
                last_seen_at=excluded.last_seen_at,changed_at=excluded.changed_at""",
                (project_id, source, subject, revision, content_hash, json.dumps(material, ensure_ascii=False), now, now),
            )
            event_key = f"obs:{project_id}:{source}:{subject}:{revision}:{content_hash[:16]}"
            event_payload = dict(payload or {})
            metadata = event_payload.get("metadata") if isinstance(event_payload.get("metadata"), dict) else {}
            event_payload["metadata"] = {**metadata, "source": source, "subject": subject, "revision": revision}
            event_payload["material"] = material
            self.db.execute(
                "INSERT INTO events(event_key,project_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)",
                (event_key, project_id, f"observation.{source}", json.dumps(event_payload, ensure_ascii=False), now),
            )
            self.db.execute("COMMIT")
            return {"changed": True, "revision": revision, "event_created": True, "event_key": event_key}
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def observation(self, project_id: str, source: str, subject: str):
        row = self.db.execute(
            "SELECT * FROM observations WHERE project_id=? AND source=? AND subject=?",
            (project_id, source, subject),
        ).fetchone()
        if not row:
            return None
        return {
            "project_id": row["project_id"], "source": row["source"], "subject": row["subject"],
            "revision": int(row["revision"]), "content_hash": row["content_hash"],
            "material": json.loads(row["material_json"] or "{}"),
            "last_seen_at": int(row["last_seen_at"]), "changed_at": int(row["changed_at"]),
        }

    def suppress_hash_only_github_comments(self) -> int:
        rows = self.db.execute(
            "SELECT id,payload_json FROM events WHERE status='pending' AND kind='observation.github' ORDER BY id"
        ).fetchall()
        suppressed = 0
        for row in rows:
            payload = json.loads(row["payload_json"] or "{}")
            metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
            material = payload.get("material") if isinstance(payload.get("material"), dict) else {}
            if str(metadata.get("githubEvent") or "") != "issue_comment":
                continue
            if not str(material.get("body_sha256") or "").strip():
                continue
            if any(str(material.get(key) or "").strip() for key in ("body", "text", "content")):
                continue
            metadata = dict(metadata)
            metadata["suppressedReason"] = "comment_body_not_persisted"
            payload["metadata"] = metadata
            self.db.execute(
                "UPDATE events SET status='suppressed',payload_json=? WHERE id=? AND status='pending'",
                (json.dumps(payload, ensure_ascii=False), int(row["id"])),
            )
            suppressed += 1
        return suppressed

    def coalesce_pending_github_events(self, quiet_seconds=15, max_items=16, now=None) -> dict:
        now = int(now if now is not None else self._now())
        quiet_seconds = max(0, int(quiet_seconds))
        max_items = max(1, min(32, int(max_items)))
        cutoff = now - quiet_seconds
        result = {"projects": 0, "source_events": 0, "coalesced_events": 0, "batch_events": 0}
        self.db.execute("BEGIN IMMEDIATE")
        try:
            projects = [row[0] for row in self.db.execute(
                """SELECT project_id FROM events WHERE status='pending' AND kind='observation.github'
                   GROUP BY project_id HAVING MAX(created_at)<=? ORDER BY project_id""", (cutoff,)).fetchall()]
            for project_id in projects:
                rows = self.db.execute(
                    "SELECT id,event_key,payload_json FROM events WHERE project_id=? AND status='pending' AND kind='observation.github' ORDER BY id",
                    (project_id,),
                ).fetchall()
                latest = {}
                for row in rows:
                    payload = json.loads(row["payload_json"] or "{}")
                    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
                    subject = str(metadata.get("subject") or row["event_key"])[:180]
                    revision = int(metadata.get("revision") or 0)
                    current = latest.get(subject)
                    if current is None or (revision, int(row["id"])) >= (current["revision"], current["id"]):
                        latest[subject] = {"id": int(row["id"]), "event_key": row["event_key"],
                                           "revision": revision, "subject": subject, "payload": payload}
                latest_ids = {item["id"] for item in latest.values()}
                stale_ids = [int(row["id"]) for row in rows if int(row["id"]) not in latest_ids]
                if stale_ids:
                    marks = ",".join("?" for _ in stale_ids)
                    self.db.execute(f"UPDATE events SET status='coalesced' WHERE id IN ({marks})", stale_ids)
                ordered = sorted(latest.values(), key=lambda item: item["id"])
                for start in range(0, len(ordered), max_items):
                    chunk = ordered[start:start + max_items]
                    if len(chunk) <= 1:
                        continue
                    fingerprint = hashlib.sha256("\n".join(item["event_key"] for item in chunk).encode()).hexdigest()[:24]
                    changes = []
                    for item in chunk:
                        payload = item["payload"]
                        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
                        changes.append({
                            "subject": item["subject"], "revision": item["revision"],
                            "summary": str(payload.get("summary") or "")[:500],
                            "githubEvent": str(metadata.get("githubEvent") or "")[:80],
                            "number": str(metadata.get("number") or "")[:80],
                            "runId": str(metadata.get("runId") or "")[:80],
                            "material": payload.get("material") if isinstance(payload.get("material"), dict) else {},
                        })
                    batch_payload = {
                        "summary": f"GitHub material batch: {len(changes)} latest observations",
                        "metadata": {"source": "github", "batchSize": len(changes),
                                     "subjects": ",".join(item["subject"] for item in chunk)[:500]},
                        "material": {"changes": changes}, "evidence": [],
                    }
                    batch_key = f"github-batch:{project_id}:{fingerprint}"
                    self.db.execute(
                        "INSERT OR IGNORE INTO events(event_key,project_id,kind,payload_json,status,created_at) VALUES(?,?,?,?,?,?)",
                        (batch_key, project_id, "observation.github.batch", json.dumps(batch_payload, ensure_ascii=False), "pending", now),
                    )
                    ids = [item["id"] for item in chunk]
                    marks = ",".join("?" for _ in ids)
                    self.db.execute(f"UPDATE events SET status='coalesced' WHERE id IN ({marks})", ids)
                    result["batch_events"] += 1
                result["projects"] += 1
                result["source_events"] += len(rows)
                result["coalesced_events"] += len(stale_ids) + sum(len(ordered[i:i + max_items]) for i in range(0, len(ordered), max_items) if len(ordered[i:i + max_items]) > 1)
            self.db.execute("COMMIT")
            return result
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def ensure_jobs(self, github_quiet_seconds=0, github_batch_max=16, now=None) -> int:
        now = int(now if now is not None else self._now())
        quiet = max(0, int(github_quiet_seconds))
        self.suppress_hash_only_github_comments()
        if quiet:
            self.coalesce_pending_github_events(quiet, github_batch_max, now=now)
        if quiet:
            cutoff = now - quiet
            cur = self.db.execute("""INSERT OR IGNORE INTO jobs(event_id,project_id,status,created_at,updated_at)
              SELECT e.id,e.project_id,'pending',?,? FROM events e
              WHERE e.status='pending' AND (e.kind!='observation.github' OR (
                e.created_at<=? AND NOT EXISTS(
                  SELECT 1 FROM events newer WHERE newer.project_id=e.project_id
                    AND newer.status='pending' AND newer.kind='observation.github' AND newer.created_at>?
                )
              ))""", (now, now, cutoff, cutoff))
        else:
            cur = self.db.execute("""INSERT OR IGNORE INTO jobs(event_id,project_id,status,created_at,updated_at)
              SELECT id,project_id,'pending',?,? FROM events WHERE status='pending'""", (now, now))
        self.db.execute("UPDATE events SET status='queued' WHERE status='pending' AND id IN (SELECT event_id FROM jobs)")
        return max(0, cur.rowcount)

    def recover_running_jobs(self):
        now = self._now()
        self.db.execute("UPDATE jobs SET status='pending',last_error='recovered_after_restart',updated_at=? WHERE status='running'", (now,))

    def claim_job(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute("""SELECT j.*,e.kind,e.payload_json FROM jobs j JOIN events e ON e.id=j.event_id
              WHERE j.status='pending' AND j.available_at<=? AND NOT EXISTS(
                SELECT 1 FROM jobs r WHERE r.project_id=j.project_id AND r.status='running')
              AND NOT EXISTS(
                SELECT 1 FROM action_requests a WHERE a.project_id=j.project_id AND a.status IN ('planned','running'))
              ORDER BY j.id LIMIT 1""", (self._now(),)).fetchone()
            if not row:
                self.db.execute("COMMIT")
                return None
            now = self._now()
            self.db.execute("UPDATE jobs SET status='running',attempts=attempts+1,updated_at=? WHERE id=?", (now, row["id"]))
            self.db.execute("COMMIT")
            return {"id": row["id"], "event_id": row["event_id"], "project_id": row["project_id"],
                    "attempts": int(row["attempts"]) + 1, "kind": row["kind"],
                    "payload": json.loads(row["payload_json"] or "{}")}
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def finish_job(self, job_id: int, decision: dict):
        now = self._now()
        row = self.db.execute("SELECT event_id,project_id FROM jobs WHERE id=?", (job_id,)).fetchone()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self.db.execute("UPDATE jobs SET status='done',decision_json=?,last_error='',updated_at=? WHERE id=?",
                            (json.dumps(decision, ensure_ascii=False), now, job_id))
            self.db.execute("UPDATE events SET status='done' WHERE id=?", (row["event_id"],))
            for sequence, action in enumerate(list(decision.get("actions") or [])):
                self.db.execute(
                    """INSERT OR IGNORE INTO action_requests(job_id,project_id,sequence,action_type,target,purpose,payload_text,status,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,'planned',?,?)""",
                    (job_id, row["project_id"], sequence, action["type"], action["target"], action["purpose"], action.get("payload", ""), now, now),
                )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def has_unfinished_work(self, project_id: str) -> bool:
        event = self.db.execute(
            "SELECT 1 FROM events WHERE project_id=? AND status IN ('pending','queued') LIMIT 1",
            (project_id,),
        ).fetchone()
        if event:
            return True
        job = self.db.execute(
            "SELECT 1 FROM jobs WHERE project_id=? AND status IN ('pending','running') LIMIT 1",
            (project_id,),
        ).fetchone()
        if job:
            return True
        action = self.db.execute(
            "SELECT 1 FROM action_requests WHERE project_id=? AND status IN ('planned','running') LIMIT 1",
            (project_id,),
        ).fetchone()
        return bool(action)

    def latest_job_state(self, project_id: str) -> dict:
        row = self.db.execute(
            "SELECT id,status,last_error,decision_json FROM jobs WHERE project_id=? ORDER BY id DESC LIMIT 1",
            (project_id,),
        ).fetchone()
        if not row:
            return {}
        return {"id": int(row["id"]), "status": str(row["status"]),
                "last_error": str(row["last_error"] or "")}

    def latest_completed_decision(self, project_id: str) -> dict:
        row = self.db.execute(
            "SELECT decision_json FROM jobs WHERE project_id=? AND status='done' AND decision_json!='{}' ORDER BY id DESC LIMIT 1",
            (project_id,),
        ).fetchone()
        if not row:
            return {}
        try:
            decision = json.loads(row["decision_json"] or "{}")
        except json.JSONDecodeError:
            return {}
        return decision if isinstance(decision, dict) else {}

    def actions_for_job(self, job_id: int):
        rows = self.db.execute(
            "SELECT sequence,action_type,target,purpose,payload_text,status FROM action_requests WHERE job_id=? ORDER BY sequence",
            (job_id,),
        ).fetchall()
        return [{"sequence": int(row["sequence"]), "type": row["action_type"], "target": row["target"],
                 "purpose": row["purpose"], "payload": row["payload_text"], "status": row["status"]} for row in rows]


    def recover_running_actions(self):
        now = self._now()
        self.db.execute(
            "UPDATE action_requests SET status='planned',last_error='recovered_after_restart',updated_at=? WHERE status='running'",
            (now,),
        )

    def claim_action(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute("""SELECT a.* FROM action_requests a
              WHERE a.status='planned' AND NOT EXISTS(
                SELECT 1 FROM action_requests r WHERE r.project_id=a.project_id AND r.status='running')
              ORDER BY a.id LIMIT 1""").fetchone()
            if not row:
                self.db.execute("COMMIT")
                return None
            now = self._now()
            self.db.execute("UPDATE action_requests SET status='running',updated_at=? WHERE id=?", (now, row["id"]))
            self.db.execute("COMMIT")
            return {"id": int(row["id"]), "job_id": int(row["job_id"]), "project_id": row["project_id"],
                    "sequence": int(row["sequence"]), "type": row["action_type"],
                    "target": row["target"], "purpose": row["purpose"], "payload": row["payload_text"]}
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def recent_action_result(self, project_id: str, action_type: str, target: str, before_action_id=None, within_seconds=60):
        upper = int(before_action_id or (2**63 - 1))
        cutoff = self._now() - max(1, int(within_seconds))
        row = self.db.execute(
            """SELECT result_json,status,updated_at FROM action_requests
               WHERE project_id=? AND action_type=? AND target=? AND id<?
                 AND status IN ('done','suppressed') AND updated_at>=?
               ORDER BY id DESC LIMIT 1""",
            (project_id, action_type, target, upper, cutoff),
        ).fetchone()
        if not row:
            return None
        try:
            result = json.loads(row["result_json"] or "{}")
        except json.JSONDecodeError:
            return None
        if not isinstance(result, dict) or not result.get("ok"):
            return None
        return result

    def ranged_read_streak(self, project_id: str, target: str, before_action_id=None, window_seconds=900) -> int:
        from .read_budget import parse_ranged_read_target
        current = parse_ranged_read_target(target)
        if not current:
            return 0
        upper = int(before_action_id or (2**63 - 1))
        cutoff = self._now() - max(1, int(window_seconds))
        rows = self.db.execute(
            """SELECT action_type,target,status,updated_at,result_json FROM action_requests
               WHERE project_id=? AND id<? AND updated_at>=? ORDER BY id DESC LIMIT 32""",
            (project_id, upper, cutoff),
        ).fetchall()
        count = 0
        for row in rows:
            previous = parse_ranged_read_target(row["target"]) if row["action_type"] == "repo.read" else None
            if not previous or previous["file_key"] != current["file_key"] or row["status"] not in {"done", "suppressed"}:
                break
            try:
                prior_result = json.loads(row["result_json"] or "{}")
            except json.JSONDecodeError:
                prior_result = {}
            if prior_result.get("cached_duplicate"):
                continue
            count += 1
        return count

    def action_failure_count(self, project_id: str, action_type: str, target: str, before_action_id=None) -> int:
        upper = int(before_action_id or (2**63 - 1))
        if str(action_type).startswith("repo."):
            alias = str(target).split(":", 1)[0]
            active = self.active_repo_workspace(project_id, alias)
            if active:
                match = re.search(r"/job-(\d+)$", str(active.get("branch") or ""))
                if match:
                    rows = self.db.execute(
                        """SELECT status FROM action_requests WHERE project_id=? AND action_type=? AND target=?
                           AND id<? AND job_id>=? ORDER BY id DESC LIMIT 20""",
                        (project_id, action_type, target, upper, int(match.group(1))),
                    ).fetchall()
                    count = 0
                    for row in rows:
                        if row["status"] != "failed":
                            break
                        count += 1
                    return count
        rows = self.db.execute(
            """SELECT action_type,target,status FROM action_requests
               WHERE project_id=? AND id<? ORDER BY id DESC LIMIT 20""",
            (project_id, upper),
        ).fetchall()
        count = 0
        for row in rows:
            if row["action_type"] == action_type and row["target"] == target and row["status"] == "failed":
                count += 1
            else:
                break
        return count

    def finish_action(self, action_id: int, status: str, result=None, last_error=""):
        allowed = {"done", "suppressed", "failed"}
        if status not in allowed:
            raise ValueError("invalid_action_status")
        cur = self.db.execute(
            "UPDATE action_requests SET status=?,result_json=?,last_error=?,updated_at=? WHERE id=? AND status='running'",
            (status, json.dumps(result or {}, ensure_ascii=False), str(last_error)[:300], self._now(), action_id),
        )
        if cur.rowcount != 1:
            raise ValueError("action_not_running")

    def action(self, action_id: int):
        row = self.db.execute("SELECT * FROM action_requests WHERE id=?", (action_id,)).fetchone()
        if not row:
            return None
        return {"id": int(row["id"]), "job_id": int(row["job_id"]), "project_id": row["project_id"],
                "sequence": int(row["sequence"]), "type": row["action_type"], "target": row["target"],
                "purpose": row["purpose"], "payload": row["payload_text"], "status": row["status"],
                "result": json.loads(row["result_json"] or "{}"), "last_error": row["last_error"]}


    def active_repo_workspace(self, project_id: str, alias: str):
        row = self.db.execute(
            "SELECT * FROM repo_workspaces WHERE project_id=? AND alias=? AND status='active' ORDER BY id DESC LIMIT 1",
            (project_id, alias),
        ).fetchone()
        if not row:
            return None
        return {"id": int(row["id"]), "project_id": row["project_id"], "alias": row["alias"],
                "branch": row["branch"], "workspace_path": row["workspace_path"],
                "base_sha": row["base_sha"], "diff_sha": row["diff_sha"],
                "last_test_sha": row["last_test_sha"], "last_test_passed": bool(row["last_test_passed"]),
                "test_attestations": json.loads(row["test_attestations_json"] or "{}"),
                "commit_sha": row["commit_sha"], "pr_number": int(row["pr_number"]), "pr_url": row["pr_url"],
                "status": row["status"],
                "created_at": int(row["created_at"]), "updated_at": int(row["updated_at"])}

    def register_repo_workspace(self, project_id: str, alias: str, branch: str, workspace_path: str, base_sha: str):
        now = self._now()
        self.db.execute(
            """INSERT INTO repo_workspaces(project_id,alias,branch,workspace_path,base_sha,status,created_at,updated_at)
               VALUES(?,?,?,?,?,'active',?,?)""",
            (project_id, alias, branch, workspace_path, base_sha, now, now),
        )
        return self.active_repo_workspace(project_id, alias)

    def set_repo_workspace_diff(self, project_id: str, alias: str, diff_sha: str):
        cur = self.db.execute(
            """UPDATE repo_workspaces SET diff_sha=?,last_test_sha='',last_test_passed=0,test_attestations_json='{}',updated_at=?
               WHERE project_id=? AND alias=? AND status='active' AND commit_sha=''""",
            (str(diff_sha), self._now(), project_id, alias),
        )
        if cur.rowcount != 1:
            raise ValueError('active_repo_workspace_missing')

    def set_repo_workspace_test(self, project_id: str, alias: str, test_alias: str, diff_sha: str, passed: bool):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute(
                "SELECT test_attestations_json FROM repo_workspaces WHERE project_id=? AND alias=? AND status='active'",
                (project_id, alias),
            ).fetchone()
            if not row:
                raise ValueError('active_repo_workspace_missing')
            try:
                attestations = json.loads(row["test_attestations_json"] or "{}")
            except json.JSONDecodeError:
                attestations = {}
            if not isinstance(attestations, dict):
                attestations = {}
            attestations[str(test_alias)] = {"diff_sha": str(diff_sha), "passed": bool(passed)}
            cur = self.db.execute(
                """UPDATE repo_workspaces SET last_test_sha=?,last_test_passed=?,test_attestations_json=?,updated_at=?
                   WHERE project_id=? AND alias=? AND status='active'""",
                (str(diff_sha), 1 if passed else 0, json.dumps(attestations, sort_keys=True), self._now(), project_id, alias),
            )
            if cur.rowcount != 1:
                raise ValueError('active_repo_workspace_missing')
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def set_repo_workspace_commit(self, project_id: str, alias: str, diff_sha: str, commit_sha: str):
        cur = self.db.execute(
            """UPDATE repo_workspaces SET commit_sha=?,updated_at=?
               WHERE project_id=? AND alias=? AND status='active' AND commit_sha=''
                 AND diff_sha=? AND last_test_sha=? AND last_test_passed=1""",
            (str(commit_sha), self._now(), project_id, alias, str(diff_sha), str(diff_sha)),
        )
        if cur.rowcount != 1:
            raise ValueError('repo_workspace_commit_precondition_failed')

    def set_repo_workspace_pr(self, project_id: str, alias: str, commit_sha: str, pr_number: int, pr_url: str):
        cur = self.db.execute(
            """UPDATE repo_workspaces SET pr_number=?,pr_url=?,updated_at=?
               WHERE project_id=? AND alias=? AND status='active' AND commit_sha=?""",
            (int(pr_number), str(pr_url)[:1000], self._now(), project_id, alias, str(commit_sha)),
        )
        if cur.rowcount != 1:
            raise ValueError('repo_workspace_publish_precondition_failed')

    def close_repo_workspace(self, project_id: str, alias: str, status='closed'):
        if status not in {'closed', 'published', 'abandoned'}:
            raise ValueError('invalid_repo_workspace_status')
        cur = self.db.execute(
            "UPDATE repo_workspaces SET status=?,updated_at=? WHERE project_id=? AND alias=? AND status='active'",
            (status, self._now(), project_id, alias),
        )
        return cur.rowcount == 1

    def block_job(self, job_id: int, reason: str):
        now = self._now()
        row = self.db.execute("SELECT event_id FROM jobs WHERE id=?", (job_id,)).fetchone()
        self.db.execute("UPDATE jobs SET status='blocked',last_error=?,updated_at=? WHERE id=?", (str(reason)[:500], now, job_id))
        self.db.execute("UPDATE events SET status='blocked' WHERE id=?", (row["event_id"],))

    def defer_job(self, job_id: int, reason: str, delay_seconds: int):
        now = self._now()
        self.db.execute("UPDATE jobs SET status='pending',last_error=?,available_at=?,updated_at=? WHERE id=?",
                        (str(reason)[:500], now + max(1, int(delay_seconds)), now, job_id))

    def update_checkpoint(self, project_id: str, checkpoint: dict):
        self.db.execute("UPDATE projects SET checkpoint_json=?,updated_at=? WHERE id=?",
                        (json.dumps(checkpoint or {}, ensure_ascii=False), self._now(), project_id))

    def record_usage(self, project_id: str, model: str, usage: dict, cost_usd: float, response_id=''):
        self.db.execute("""INSERT INTO usage(project_id,response_id,model,input_tokens,cached_input_tokens,
          output_tokens,cost_usd,created_at) VALUES(?,?,?,?,?,?,?,?)""",
          (project_id, response_id, model, int(usage.get('input_tokens',0)), int(usage.get('cached_input_tokens',0)),
           int(usage.get('output_tokens',0)), float(cost_usd), self._now()))

    def month_cost(self, now=None) -> float:
        now = time.gmtime(now or time.time())
        start = int(calendar.timegm((now.tm_year, now.tm_mon, 1, 0, 0, 0, 0, 0, 0)))
        row = self.db.execute("SELECT COALESCE(SUM(cost_usd),0) AS cost FROM usage WHERE created_at>=?", (start,)).fetchone()
        return float(row['cost'])

    def project_ids(self):
        return [row[0] for row in self.db.execute("SELECT id FROM projects ORDER BY id").fetchall()]

    def counts(self) -> dict:
        return {
            'projects': self.db.execute("SELECT COUNT(*) FROM projects").fetchone()[0],
            'events': self.db.execute("SELECT COUNT(*) FROM events").fetchone()[0],
            'observations': self.db.execute("SELECT COUNT(*) FROM observations").fetchone()[0],
            'jobs': self.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0],
            'pending_jobs': self.db.execute("SELECT COUNT(*) FROM jobs WHERE status='pending'").fetchone()[0],
            'planned_actions': self.db.execute("SELECT COUNT(*) FROM action_requests WHERE status='planned'").fetchone()[0],
        }
