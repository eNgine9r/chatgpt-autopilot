import tempfile
import unittest
from pathlib import Path
from src.browserless.store import BrowserlessStore


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "core.sqlite3")
        self.store = BrowserlessStore(self.db)
        self.store.register_project("p1", "2026-09-04-v1", "anchor", {})

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_database_file_is_private_by_default(self):
        self.assertEqual(Path(self.db).stat().st_mode & 0o777, 0o600)

    def test_repo_workspace_is_durable_unique_and_closeable(self):
        created=self.store.register_repo_workspace("p1","repo","autopilot/browserless/p1/job-1","/tmp/ws-1","a"*40)
        self.assertEqual(created["branch"],"autopilot/browserless/p1/job-1")
        self.store.close(); self.store=BrowserlessStore(self.db)
        active=self.store.active_repo_workspace("p1","repo")
        self.assertEqual(active["workspace_path"],"/tmp/ws-1")
        with self.assertRaises(Exception):
            self.store.register_repo_workspace("p1","repo","other","/tmp/ws-2","b"*40)
        self.assertTrue(self.store.close_repo_workspace("p1","repo","abandoned"))
        self.assertIsNone(self.store.active_repo_workspace("p1","repo"))

    def test_old_workspace_schema_adds_test_attestations_column(self):
        import sqlite3
        legacy = str(Path(self.tmp.name) / "legacy.sqlite3")
        db = sqlite3.connect(legacy)
        db.execute("""CREATE TABLE repo_workspaces(
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, alias TEXT NOT NULL,
          branch TEXT NOT NULL, workspace_path TEXT NOT NULL, base_sha TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)""")
        db.commit(); db.close()
        migrated=BrowserlessStore(legacy)
        try:
            columns={row[1] for row in migrated.db.execute("PRAGMA table_info(repo_workspaces)")}
            self.assertIn("test_attestations_json",columns)
            row=migrated.db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='repo_workspaces'").fetchone()
            self.assertIsNotNone(row)
        finally:
            migrated.close()
        self.assertEqual(Path(legacy).stat().st_mode & 0o777,0o600)

    def test_event_key_is_idempotent(self):
        self.assertTrue(self.store.enqueue_event("p1", "evt-1", "github", {"summary":"x"}))
        self.assertFalse(self.store.enqueue_event("p1", "evt-1", "github", {"summary":"x"}))
        self.store.ensure_jobs()
        self.assertEqual(self.store.counts()["jobs"], 1)

    def test_project_jobs_are_serialized(self):
        self.store.enqueue_event("p1", "evt-1", "a", {})
        self.store.enqueue_event("p1", "evt-2", "b", {})
        self.store.ensure_jobs()
        first = self.store.claim_job()
        self.assertIsNotNone(first)
        self.assertIsNone(self.store.claim_job())
        self.store.finish_job(first["id"], {"decision":"wait"})
        self.assertIsNotNone(self.store.claim_job())

    def test_same_project_job_waits_until_planned_and_running_actions_drain(self):
        self.store.enqueue_event("p1", "seed-action", "seed", {})
        self.store.ensure_jobs(); first=self.store.claim_job()
        self.store.finish_job(first["id"], {"decision":"continue","actions":[
            {"type":"github.read","target":"repo:issue:1","purpose":"read","payload":""}]})
        self.store.enqueue_event("p1", "next-job", "seed", {})
        self.store.ensure_jobs()
        self.assertIsNone(self.store.claim_job())
        action=self.store.claim_action(); self.assertIsNotNone(action)
        self.assertIsNone(self.store.claim_job())
        self.store.finish_action(action["id"], "done", {"ok":True}, "")
        next_job=self.store.claim_job(); self.assertIsNotNone(next_job)
        self.assertEqual(next_job["project_id"], "p1")

    def test_other_project_job_can_run_while_first_project_actions_are_pending(self):
        self.store.register_project("p2", "2026-09-04-v1", "anchor", {})
        self.store.enqueue_event("p1", "seed-action", "seed", {})
        self.store.ensure_jobs(); first=self.store.claim_job()
        self.store.finish_job(first["id"], {"decision":"continue","actions":[
            {"type":"github.read","target":"repo:issue:1","purpose":"read","payload":""}]})
        self.store.enqueue_event("p1", "p1-next", "seed", {})
        self.store.enqueue_event("p2", "p2-next", "seed", {})
        self.store.ensure_jobs()
        claimed=self.store.claim_job(); self.assertIsNotNone(claimed)
        self.assertEqual(claimed["project_id"], "p2")

    def test_register_project_preserves_newer_durable_checkpoint(self):
        self.store.update_checkpoint("p1", {"goal":"new"})
        self.store.register_project("p1", "2026-09-04-v1", "anchor2", {"goal":"stale"})
        self.assertEqual(self.store.project("p1")["checkpoint"]["goal"], "new")
        self.assertEqual(self.store.project("p1")["plan_anchor"], "anchor2")

    def test_running_job_recovers_after_restart(self):
        self.store.enqueue_event("p1", "evt-1", "a", {})
        self.store.ensure_jobs()
        first = self.store.claim_job()
        self.assertIsNotNone(first)
        self.store.close()
        self.store = BrowserlessStore(self.db)
        self.store.recover_running_jobs()
        recovered = self.store.claim_job()
        self.assertEqual(recovered["event_id"], first["event_id"])
    def test_repo_failure_count_is_scoped_to_active_workspace_session(self):
        def make_action(event_key, kind, target, status):
            self.store.enqueue_event("p1",event_key,"seed",{})
            self.store.ensure_jobs(); job=self.store.claim_job()
            self.store.finish_job(job["id"],{"decision":"continue","actions":[{"type":kind,"target":target,"purpose":"x","payload":""}]})
            action=self.store.claim_action(); self.store.finish_action(action["id"],status,{},"repo_patch_apply_failed" if status=="failed" else "")
            return action
        first=make_action("f1","repo.patch","repo","failed")
        self.store.register_repo_workspace("p1","repo",f"autopilot/browserless/p1/job-{first['job_id']}","/tmp/ws-a","a"*40)
        make_action("read","repo.read","repo:file:app.py","done")
        second_seed=self.store.enqueue_event("p1","f2","seed",{}); self.assertTrue(second_seed)
        self.store.ensure_jobs(); job=self.store.claim_job()
        self.store.finish_job(job["id"],{"decision":"continue","actions":[{"type":"repo.patch","target":"repo","purpose":"x","payload":""}]})
        second=self.store.claim_action()
        self.assertEqual(self.store.action_failure_count("p1","repo.patch","repo",second["id"]),1)
        self.store.finish_action(second["id"],"failed",{},"repo_patch_apply_failed")
        self.store.enqueue_event("p1","patch-ok","seed",{}); self.store.ensure_jobs(); job=self.store.claim_job()
        self.store.finish_job(job["id"],{"decision":"continue","actions":[{"type":"repo.patch","target":"repo","purpose":"x","payload":""}]})
        succeeded=self.store.claim_action(); self.store.finish_action(succeeded["id"],"done",{},"")
        self.store.enqueue_event("p1","patch-after-ok","seed",{}); self.store.ensure_jobs(); job=self.store.claim_job()
        self.store.finish_job(job["id"],{"decision":"continue","actions":[{"type":"repo.patch","target":"repo","purpose":"x","payload":""}]})
        after_ok=self.store.claim_action()
        self.assertEqual(self.store.action_failure_count("p1","repo.patch","repo",after_ok["id"]),0)
        self.store.finish_action(after_ok["id"],"done",{},"")
        self.assertTrue(self.store.close_repo_workspace("p1","repo","abandoned"))
        prep=make_action("prep","repo.prepare","repo","done")
        self.store.register_repo_workspace("p1","repo",f"autopilot/browserless/p1/job-{prep['job_id']}","/tmp/ws-b","b"*40)
        self.store.enqueue_event("p1","f-new","seed",{}); self.store.ensure_jobs(); job=self.store.claim_job()
        self.store.finish_job(job["id"],{"decision":"continue","actions":[{"type":"repo.patch","target":"repo","purpose":"x","payload":""}]})
        fresh=self.store.claim_action()
        self.assertEqual(self.store.action_failure_count("p1","repo.patch","repo",fresh["id"]),0)
    def test_github_quiet_window_coalesces_latest_subject_revisions_into_one_job(self):
        from src.browserless.ingress import ingest_observation
        now = self.store._now()
        ingest_observation(self.store,"p1","github","pr:7",{"summary":"opened","metadata":{"githubEvent":"pull_request"},"material":{"state":"open","revisionHint":1}})
        ingest_observation(self.store,"p1","github","pr:7",{"summary":"merged","metadata":{"githubEvent":"pull_request"},"material":{"state":"closed","merged":True,"revisionHint":2}})
        ingest_observation(self.store,"p1","github","issue:9",{"summary":"closed","metadata":{"githubEvent":"issues"},"material":{"state":"closed","state_reason":"completed"}})
        self.store.ensure_jobs(github_quiet_seconds=15, now=now+5)
        self.assertEqual(self.store.counts()["jobs"],0)
        self.store.ensure_jobs(github_quiet_seconds=15, now=now+20)
        self.assertEqual(self.store.counts()["jobs"],1)
        job=self.store.claim_job(); self.assertEqual(job["kind"],"observation.github.batch")
        changes=job["payload"]["material"]["changes"]
        self.assertEqual(len(changes),2)
        pr=[item for item in changes if item["subject"]=="pr:7"][0]
        self.assertEqual(pr["revision"],2); self.assertTrue(pr["material"]["merged"]); self.assertEqual(pr["material"]["state"],"closed")
        rows=self.store.db.execute("SELECT kind,status,COUNT(*) n FROM events GROUP BY kind,status ORDER BY kind,status").fetchall()
        grouped={(row["kind"],row["status"]):int(row["n"]) for row in rows}
        self.assertEqual(grouped[("observation.github","coalesced")],3)
        self.assertEqual(grouped[("observation.github.batch","queued")],1)

    def test_github_batch_preserves_authoritative_workflow_run_id(self):
        from src.browserless.ingress import ingest_observation
        now=self.store._now()
        ingest_observation(self.store,"p1","github","workflow:317326122:abc",{
            "summary":"CI completed","metadata":{"githubEvent":"workflow_run","runId":"34053949036"},
            "material":{"status":"completed","conclusion":"success","run_number":4388}})
        ingest_observation(self.store,"p1","github","pr:954",{
            "summary":"PR open","metadata":{"githubEvent":"pull_request","number":"954"},"material":{"state":"open"}})
        self.store.ensure_jobs(github_quiet_seconds=15,now=now+20)
        job=self.store.claim_job(); self.assertEqual(job["kind"],"observation.github.batch")
        workflow=[x for x in job["payload"]["material"]["changes"] if x["githubEvent"]=="workflow_run"][0]
        self.assertEqual(workflow["runId"],"34053949036")
        self.assertNotEqual(workflow["runId"],"317326122")
        self.assertNotEqual(workflow["runId"],str(workflow["material"]["run_number"]))

    def test_single_github_event_waits_for_quiet_window_then_queues_once(self):
        from src.browserless.ingress import ingest_observation
        now=self.store._now()
        ingest_observation(self.store,"p1","github","issue:3",{"summary":"closed","material":{"state":"closed"}})
        self.store.ensure_jobs(github_quiet_seconds=15,now=now+10)
        self.assertEqual(self.store.counts()["jobs"],0)
        self.store.ensure_jobs(github_quiet_seconds=15,now=now+16)
        self.assertEqual(self.store.counts()["jobs"],1)
        self.store.ensure_jobs(github_quiet_seconds=15,now=now+30)
        self.assertEqual(self.store.counts()["jobs"],1)

    def test_new_github_event_resets_quiet_window_for_entire_project(self):
        from src.browserless.ingress import ingest_observation
        now=self.store._now()
        ingest_observation(self.store,"p1","github","issue:old",{"summary":"old","material":{"state":"open"}})
        ingest_observation(self.store,"p1","github","issue:new",{"summary":"new","material":{"state":"open"}})
        rows=self.store.db.execute("SELECT id FROM events WHERE kind='observation.github' ORDER BY id").fetchall()
        self.store.db.execute("UPDATE events SET created_at=? WHERE id=?",(now-20,int(rows[0]["id"])))
        self.store.db.execute("UPDATE events SET created_at=? WHERE id=?",(now-5,int(rows[1]["id"])))
        self.store.ensure_jobs(github_quiet_seconds=15,now=now)
        self.assertEqual(self.store.counts()["jobs"],0)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM events WHERE status='pending'").fetchone()[0],2)
        self.store.ensure_jobs(github_quiet_seconds=15,now=now+11)
        self.assertEqual(self.store.counts()["jobs"],1)
        job=self.store.claim_job(); self.assertEqual(job["kind"],"observation.github.batch")
        self.assertEqual(len(job["payload"]["material"]["changes"]),2)

    def test_operator_event_is_immediate_while_github_event_is_debounced(self):
        from src.browserless.ingress import ingest_observation
        now=self.store._now()
        ingest_observation(self.store,"p1","github","issue:4",{"summary":"opened","material":{"state":"open"}})
        self.store.enqueue_event("p1","operator-now","operator.task",{"summary":"continue now"})
        self.store.ensure_jobs(github_quiet_seconds=15,now=now+1)
        self.assertEqual(self.store.counts()["jobs"],1)
        job=self.store.claim_job(); self.assertEqual(job["kind"],"operator.task")
