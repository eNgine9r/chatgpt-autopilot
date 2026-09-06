import calendar
import json
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
          action_type TEXT NOT NULL, target TEXT NOT NULL, purpose TEXT NOT NULL,
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

    def ensure_jobs(self) -> int:
        now = self._now()
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
                    """INSERT OR IGNORE INTO action_requests(job_id,project_id,sequence,action_type,target,purpose,status,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,'planned',?,?)""",
                    (job_id, row["project_id"], sequence, action["type"], action["target"], action["purpose"], now, now),
                )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def actions_for_job(self, job_id: int):
        rows = self.db.execute(
            "SELECT sequence,action_type,target,purpose,status FROM action_requests WHERE job_id=? ORDER BY sequence",
            (job_id,),
        ).fetchall()
        return [{"sequence": int(row["sequence"]), "type": row["action_type"], "target": row["target"],
                 "purpose": row["purpose"], "status": row["status"]} for row in rows]


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
                    "target": row["target"], "purpose": row["purpose"]}
        except Exception:
            self.db.execute("ROLLBACK")
            raise

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
                "purpose": row["purpose"], "status": row["status"],
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
                "base_sha": row["base_sha"], "status": row["status"],
                "created_at": int(row["created_at"]), "updated_at": int(row["updated_at"])}

    def register_repo_workspace(self, project_id: str, alias: str, branch: str, workspace_path: str, base_sha: str):
        now = self._now()
        self.db.execute(
            """INSERT INTO repo_workspaces(project_id,alias,branch,workspace_path,base_sha,status,created_at,updated_at)
               VALUES(?,?,?,?,?,'active',?,?)""",
            (project_id, alias, branch, workspace_path, base_sha, now, now),
        )
        return self.active_repo_workspace(project_id, alias)

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
