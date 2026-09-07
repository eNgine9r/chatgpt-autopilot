import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from src.browserless.telemetry import snapshot


class BrowserlessTelemetryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "core.sqlite3"
        con = sqlite3.connect(self.db_path)
        con.executescript("""
        CREATE TABLE projects(id TEXT PRIMARY KEY, plan_version TEXT NOT NULL, plan_anchor TEXT NOT NULL, checkpoint_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE events(id INTEGER PRIMARY KEY, event_key TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE jobs(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, decision_json TEXT NOT NULL, last_error TEXT NOT NULL, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE action_requests(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, project_id TEXT NOT NULL, sequence INTEGER NOT NULL, action_type TEXT NOT NULL, target TEXT NOT NULL, purpose TEXT NOT NULL, payload_text TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT NOT NULL, last_error TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE usage(id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, response_id TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, created_at INTEGER NOT NULL);
        """)
        self.con = con

    def tearDown(self):
        self.con.close()
        self.tmp.cleanup()

    def test_snapshot_aggregates_usage_budget_queue_and_project_state(self):
        today = 1788792000
        earlier = 1788446400
        checkpoint = json.dumps({"stage":"active","goal":"Ship","currentTask":"Verify","nextAction":"Merge","blockers":[]})
        self.con.execute("INSERT INTO projects VALUES(?,?,?,?,?)", ("p1","2026-09-04-v1","anchor",checkpoint,today))
        self.con.execute("INSERT INTO projects VALUES(?,?,?,?,?)", ("p2","2026-09-04-v1","anchor",json.dumps({"stage":"complete","blockers":[]}),today))
        self.con.execute("INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?)", (1,"p1","r1","gpt-5.6-luna",1000,400,200,0.10,earlier))
        self.con.execute("INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?)", (2,"p1","r2","gpt-5.6-luna",2000,1000,300,0.20,today))
        self.con.execute("INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?)", (3,"p2","r3","gpt-5.6-luna",500,100,100,0.05,today))
        self.con.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?)", (1,"e1","p1","observation.github","{}","queued",today))
        self.con.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?)", (2,"e2","p2","observation.github","{}","done",today))
        self.con.execute("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)", (1,1,"p1","pending",0,"{}","",0,today,today))
        self.con.execute("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)", (2,2,"p1","done",1,json.dumps({"decision":"wait"}),"",0,today,today))
        self.con.execute("INSERT INTO action_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (1,2,"p1",0,"github.read","x","read","","planned","{}","",today,today))
        self.con.commit()
        result = snapshot(self.db_path, now_ms=1788798000*1000, target_monthly_usd=20, hard_monthly_usd=30)
        self.assertTrue(result["available"])
        self.assertEqual(result["model"], "gpt-5.6-luna")
        self.assertEqual(result["usage"]["month"]["calls"], 3)
        self.assertEqual(result["usage"]["today"]["calls"], 2)
        self.assertEqual(result["usage"]["month"]["inputTokens"], 3500)
        self.assertEqual(result["usage"]["month"]["cachedInputTokens"], 1500)
        self.assertAlmostEqual(result["budget"]["monthCostUsd"], 0.35)
        self.assertAlmostEqual(result["budget"]["remainingHardUsd"], 29.65)
        self.assertEqual(result["queue"]["eventsQueued"], 1)
        self.assertEqual(result["queue"]["jobsPending"], 1)
        self.assertEqual(result["queue"]["actionsPlanned"], 1)
        self.assertEqual(result["activity"]["eventsToday"], 2)
        p1 = next(p for p in result["projects"] if p["id"] == "p1")
        self.assertEqual(p1["checkpoint"]["currentTask"], "Verify")
        self.assertEqual(p1["latestJob"]["decision"], "wait")
        self.assertEqual(p1["usageMonth"]["calls"], 2)


if __name__ == "__main__":
    unittest.main()
