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

    def close(self):
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
        CREATE TABLE IF NOT EXISTS usage(
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
          response_id TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, input_tokens INTEGER NOT NULL,
          cached_input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
          cost_usd REAL NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_events_status ON events(status,id);
        CREATE INDEX IF NOT EXISTS idx_jobs_status_project ON jobs(status,project_id,id);
        CREATE INDEX IF NOT EXISTS idx_usage_created ON usage(created_at);
        """)
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(jobs)")}
        if "available_at" not in columns:
            self.db.execute("ALTER TABLE jobs ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0")

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
        row = self.db.execute("SELECT event_id FROM jobs WHERE id=?", (job_id,)).fetchone()
        self.db.execute("UPDATE jobs SET status='done',decision_json=?,last_error='',updated_at=? WHERE id=?",
                        (json.dumps(decision, ensure_ascii=False), now, job_id))
        self.db.execute("UPDATE events SET status='done' WHERE id=?", (row["event_id"],))

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

    def counts(self) -> dict:
        return {
            'events': self.db.execute("SELECT COUNT(*) FROM events").fetchone()[0],
            'jobs': self.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0],
            'pending_jobs': self.db.execute("SELECT COUNT(*) FROM jobs WHERE status='pending'").fetchone()[0],
        }
