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
    def __init__(self, code="repo_patch_invalid", detail=""): self.calls=0; self.code=code; self.detail=detail
    def execute(self, _action):
        self.calls += 1
        raise ReadActionError(self.code, self.detail)


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

    def test_action_result_creates_one_suppression_signal_and_repeat_state_is_idempotent(self):
        action={"type":"github.read","target":"repo:issue:107","purpose":"fresh","payload":""}
        self.plan_action("seed-1", action)
        executor=FakeExecutor()
        first=execute_once(self.store,executor)
        self.assertEqual(first["status"],"done"); self.assertTrue(first["event_created"])
        # Process the evidence event as if Luna requested the same read again.
        self.store.ensure_jobs(); evidence_job=self.store.claim_job()
        self.store.finish_job(evidence_job["id"],{"decision":"continue","actions":[action]})
        second=execute_once(self.store,executor)
        self.assertEqual(second["status"],"suppressed"); self.assertTrue(second["event_created"])
        self.assertTrue(second["suppression_event_created"])
        row=self.store.db.execute("SELECT material_json FROM observations WHERE source='evidence' AND subject LIKE 'suppressed:%'").fetchone()
        import json
        material=json.loads(row[0])
        self.assertTrue(material["suppressed_unchanged"]); self.assertEqual(material["action_type"],"github.read")
        self.assertEqual(material["target"],"repo:issue:107"); self.assertEqual(len(material["result_sha256"]),64)
        # Bypass core once to prove the suppression observation itself is idempotent for the same result state.
        self.store.ensure_jobs(); suppression_job=self.store.claim_job()
        self.store.finish_job(suppression_job["id"],{"decision":"continue","actions":[action]})
        third=execute_once(self.store,executor)
        self.assertEqual(third["status"],"suppressed"); self.assertTrue(third["event_created"])
        self.assertFalse(third["suppression_event_created"]); self.assertTrue(third["suppression_reused_event_created"])
        reused=self.store.db.execute("SELECT payload_json FROM events WHERE event_key LIKE 'suppression-reused:%'").fetchone()
        self.assertIsNotNone(reused)
        reused_payload=json.loads(reused[0]); self.assertTrue(reused_payload["material"]["suppressed_unchanged"])
        self.assertTrue(reused_payload["material"]["suppression_reused"])
        self.assertEqual(reused_payload["material"]["target"],"repo:issue:107")
        self.assertEqual(executor.calls,3)
        self.assertEqual(self.store.counts()["events"],4)  # seed + first evidence + suppression signal + reused continuation
        count=self.store.db.execute("SELECT COUNT(*) FROM observations WHERE source='evidence' AND subject LIKE 'suppressed:%'").fetchone()[0]
        self.assertEqual(count,1)

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

    def test_failure_detail_is_bounded_evidence_while_last_error_stays_stable(self):
        action={"type":"repo.patch","target":"repo","purpose":"patch","payload":"diff"}
        self.plan_action("seed-detail", action)
        result=execute_once(self.store,FailingExecutor("repo_patch_apply_failed","hunk_mismatch"))
        stored=self.store.action(result["action_id"])
        self.assertEqual(stored["last_error"],"repo_patch_apply_failed")
        self.assertEqual(stored["result"]["error_detail"],"hunk_mismatch")
        row=self.store.db.execute("SELECT material_json FROM observations WHERE source='evidence'").fetchone()
        import json
        material=json.loads(row[0])
        self.assertEqual(material["error_code"],"repo_patch_apply_failed")
        self.assertEqual(material["error_detail"],"hunk_mismatch")
        self.assertEqual(material["failure_attempt"],1)

    def test_unsafe_failure_detail_is_not_exposed(self):
        action={"type":"repo.patch","target":"repo","purpose":"patch","payload":"diff"}
        self.plan_action("seed-unsafe-detail", action)
        result=execute_once(self.store,FailingExecutor("repo_patch_apply_failed","/home/private/raw stderr"))
        stored=self.store.action(result["action_id"])
        self.assertNotIn("error_detail",stored["result"])
        row=self.store.db.execute("SELECT material_json FROM observations WHERE source='evidence'").fetchone()
        self.assertNotIn("/home/private",row[0])


    def _finish_direct_action(self, event_key, target, action_type="repo.read", status="done"):
        self.store.enqueue_event("p",event_key,"seed",{})
        self.store.ensure_jobs(); job=self.store.claim_job()
        self.store.finish_job(job["id"],{"decision":"continue","actions":[{"type":action_type,"target":target,"purpose":"budget","payload":""}]})
        action=self.store.claim_action(); self.store.finish_action(action["id"],status,{"ok":True})
        return action

    def test_exact_ranged_duplicate_reuses_recent_result_without_external_read(self):
        action={"type":"repo.read","target":"btc:lines:100:80:app/db/stats.py","purpose":"window","payload":""}
        self.plan_action("cooldown-first",action)
        first_executor=FakeExecutor({"ok":True,"kind":"repo","alias":"btc","operation":"lines","content":"window","sha256":"a"*64})
        first=execute_once(self.store,first_executor)
        self.assertEqual(first["status"],"done"); self.assertTrue(first["external_read"]); self.assertEqual(first_executor.calls,1)
        self.plan_action("cooldown-second",action)
        second_executor=FakeExecutor({"ok":True,"kind":"repo","content":"must-not-run"})
        second=execute_once(self.store,second_executor)
        self.assertEqual(second["status"],"suppressed"); self.assertFalse(second["external_read"]); self.assertEqual(second_executor.calls,0)
        stored=self.store.action(second["action_id"]); self.assertTrue(stored["result"]["cached_duplicate"])
        self.assertEqual(self.store.ranged_read_streak("p",action["target"]),1)

    def test_exact_ranged_duplicate_cache_expires_after_sixty_seconds(self):
        action={"type":"repo.read","target":"btc:lines:200:80:app/db/stats.py","purpose":"window","payload":""}
        self.plan_action("cooldown-expire-first",action)
        first=execute_once(self.store,FakeExecutor({"ok":True,"kind":"repo","content":"old"}))
        self.store.db.execute("UPDATE action_requests SET updated_at=updated_at-120 WHERE id=?",(first["action_id"],))
        self.plan_action("cooldown-expire-second",action)
        executor=FakeExecutor({"ok":True,"kind":"repo","content":"fresh"})
        second=execute_once(self.store,executor)
        self.assertTrue(second["external_read"]); self.assertEqual(executor.calls,1)

    def test_seventh_consecutive_ranged_read_is_blocked_before_executor(self):
        for i in range(6):
            self._finish_direct_action(f"range-{i}",f"btc:lines:{1+i*100}:100:app/db/stats.py")
        self.plan_action("range-7",{"type":"repo.read","target":"btc:lines:601:100:app/db/stats.py","purpose":"next","payload":""})
        executor=FakeExecutor({"ok":True,"kind":"repo","content":"should-not-run"})
        result=execute_once(self.store,executor)
        self.assertEqual(result["status"],"failed"); self.assertFalse(result["external_read"]); self.assertEqual(executor.calls,0)
        stored=self.store.action(result["action_id"]); self.assertEqual(stored["last_error"],"repo_ranged_read_budget_exhausted")
        self.assertTrue(stored["result"]["read_budget_exhausted"]); self.assertEqual(stored["result"]["blocked_file"],"btc:app/db/stats.py")

    def test_distinct_action_breaks_ranged_read_streak(self):
        for i in range(6):
            self._finish_direct_action(f"range-reset-{i}",f"btc:lines:{1+i*100}:100:app/db/stats.py")
        self._finish_direct_action("search-reset","btc:search:mainnet")
        self.plan_action("range-after-reset",{"type":"repo.read","target":"btc:lines:601:100:app/db/stats.py","purpose":"next","payload":""})
        executor=FakeExecutor({"ok":True,"kind":"repo","content":"allowed"})
        result=execute_once(self.store,executor)
        self.assertEqual(result["status"],"done"); self.assertTrue(result["external_read"]); self.assertEqual(executor.calls,1)

    def test_old_ranged_reads_do_not_count_after_budget_window(self):
        for i in range(6):
            self._finish_direct_action(f"range-old-{i}",f"btc:lines:{1+i*100}:100:app/db/stats.py")
        self.store.db.execute("UPDATE action_requests SET updated_at=updated_at-3600")
        self.plan_action("range-fresh",{"type":"repo.read","target":"btc:lines:601:100:app/db/stats.py","purpose":"fresh","payload":""})
        executor=FakeExecutor({"ok":True,"kind":"repo","content":"allowed"})
        result=execute_once(self.store,executor)
        self.assertEqual(result["status"],"done"); self.assertEqual(executor.calls,1)

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
