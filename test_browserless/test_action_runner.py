import tempfile
import unittest
from pathlib import Path

from src.browserless.action_runner import execute_once
from src.browserless.read_tools import ReadActionError
from src.browserless.store import BrowserlessStore


class FakeExecutor:
    def __init__(self, result=None): self.calls=0; self.result=result or {"ok":True,"kind":"github","data":{"state":"open"}}
    def execute(self, _action): self.calls += 1; return self.result


class FailingExecutor:
    def __init__(self, code="repo_patch_invalid"): self.calls=0; self.code=code
    def execute(self, _action):
        self.calls += 1
        raise ReadActionError(self.code)


class ActionRunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.db=str(Path(self.tmp.name)/"core.sqlite3")
        self.store=BrowserlessStore(self.db); self.store.register_project("p","2026-09-04-v1","anchor",{})

    def tearDown(self): self.store.close(); self.tmp.cleanup()

    def plan_action(self, event_key, action=None):
        self.store.enqueue_event("p",event_key,"seed",{})
        self.store.ensure_jobs(); job=self.store.claim_job()
        action = action or {"type":"github.read","target":"repo:issue:107","purpose":"fresh"}
        self.store.finish_job(job["id"],{"decision":"continue","actions":[action]})
        return job

    def test_action_result_creates_one_evidence_event_then_unchanged_repeat_is_suppressed(self):
        self.plan_action("seed-1")
        executor=FakeExecutor()
        first=execute_once(self.store,executor)
        self.assertEqual(first["status"],"done"); self.assertTrue(first["event_created"])
        # Process the evidence event as if Luna requested the same read again.
        self.store.ensure_jobs(); evidence_job=self.store.claim_job()
        self.store.finish_job(evidence_job["id"],{"decision":"continue","actions":[{"type":"github.read","target":"repo:issue:107","purpose":"recheck"}]})
        second=execute_once(self.store,executor)
        self.assertEqual(second["status"],"suppressed"); self.assertFalse(second["event_created"])
        self.assertEqual(executor.calls,2)
        self.assertEqual(self.store.counts()["events"],2)  # seed + first evidence only

    def test_repeated_identical_failure_creates_bounded_retry_evidence(self):
        action={"type":"repo.patch","target":"repo","purpose":"patch","payload":"diff"}
        self.plan_action("seed-fail-1", action)
        executor=FailingExecutor()
        first=execute_once(self.store,executor)
        self.assertEqual(first["status"],"failed"); self.assertTrue(first["event_created"])
        obs=self.store.observation("p","evidence", next(row[0] for row in self.store.db.execute("SELECT subject FROM observations WHERE source='evidence'")))
        self.assertEqual(obs["material"]["failure_attempt"],1); self.assertFalse(obs["material"]["retry_exhausted"])
        self.store.ensure_jobs(); job=self.store.claim_job()
        self.store.finish_job(job["id"],{"decision":"continue","actions":[action]})
        second=execute_once(self.store,executor)
        self.assertEqual(second["status"],"failed"); self.assertTrue(second["event_created"])
        row=self.store.db.execute("SELECT material_json FROM observations WHERE source='evidence'").fetchone()
        import json
        material=json.loads(row[0])
        self.assertEqual(material["failure_attempt"],2); self.assertTrue(material["retry_exhausted"])
        self.assertEqual(executor.calls,2)

    def test_running_action_recovers_after_restart(self):
        self.plan_action("seed-1"); action=self.store.claim_action(); self.assertIsNotNone(action)
        self.store.close(); self.store=BrowserlessStore(self.db); self.store.recover_running_actions()
        recovered=self.store.claim_action(); self.assertEqual(recovered["id"],action["id"])

    def test_action_cannot_be_finished_without_running_claim(self):
        self.plan_action("seed-1")
        row = self.store.db.execute("SELECT id FROM action_requests ORDER BY id LIMIT 1").fetchone()
        with self.assertRaises(ValueError): self.store.finish_action(int(row[0]),"done",{"ok":True})

    def test_idle_executor_performs_no_external_read(self):
        executor=FakeExecutor(); result=execute_once(self.store,executor)
        self.assertEqual(result,{"status":"idle","external_read":False}); self.assertEqual(executor.calls,0)

    def test_local_workspace_path_is_stored_locally_but_excluded_from_ai_evidence(self):
        job=self.plan_action("seed-path", {"type":"repo.prepare","target":"repo","purpose":"prepare","payload":""})
        executor=FakeExecutor({"ok":True,"kind":"repo","operation":"prepare","alias":"repo",
                               "workspace":"/home/private/workspaces/job-1","workspace_id":7,"branch":"b"})
        result=execute_once(self.store,executor)
        action=self.store.action(result["action_id"])
        self.assertEqual(action["result"]["workspace"],"/home/private/workspaces/job-1")
        row=self.store.db.execute("SELECT material_json FROM observations WHERE source='evidence' ORDER BY changed_at DESC LIMIT 1").fetchone()
        self.assertIsNotNone(row)
        self.assertNotIn("/home/private",row[0]); self.assertNotIn("workspace",row[0])
        self.assertNotIn("workspace_id",row[0]); self.assertIn("branch",row[0])
