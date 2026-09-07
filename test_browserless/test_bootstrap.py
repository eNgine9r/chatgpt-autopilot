import tempfile
import unittest
from pathlib import Path

from src.browserless.bootstrap import enqueue_checkpoint_bootstraps
from src.browserless.store import BrowserlessStore


def checkpoint(next_action="continue", stage="active"):
    return {"goal":"g","completed":[],"currentTask":"task","decisions":[],"evidence":[],"blockers":[],
            "nextAction":next_action,"doNotRepeat":[],"planVersion":"2026-09-04-v1","stage":stage,"githubPr":0,"revision":7}


class BootstrapTest(unittest.TestCase):
    def test_active_checkpoint_bootstraps_exactly_once_across_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=str(Path(tmp)/"core.sqlite3")
            store=BrowserlessStore(path); store.register_project("p1","2026-09-04-v1","anchor",checkpoint())
            self.assertTrue(enqueue_checkpoint_bootstraps(store)[0]["inserted"])
            self.assertEqual(enqueue_checkpoint_bootstraps(store), [])
            self.assertEqual(store.counts()["events"],1); store.close()
            store=BrowserlessStore(path)
            self.assertEqual(enqueue_checkpoint_bootstraps(store), [])
            self.assertEqual(store.counts()["events"],1); store.close()

    def test_changed_checkpoint_creates_new_resume_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            store=BrowserlessStore(str(Path(tmp)/"core.sqlite3")); store.register_project("p1","2026-09-04-v1","anchor",checkpoint("a"))
            enqueue_checkpoint_bootstraps(store); store.ensure_jobs(); job=store.claim_job()
            store.finish_job(job["id"], {"decision":"continue","actions":[]}); store.update_checkpoint("p1",checkpoint("b"))
            self.assertTrue(enqueue_checkpoint_bootstraps(store)[0]["inserted"])
            self.assertEqual(store.counts()["events"],2); store.close()


    def test_revision_only_change_does_not_create_new_resume_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            store=BrowserlessStore(str(Path(tmp)/"core.sqlite3")); cp=checkpoint("a"); store.register_project("p1","2026-09-04-v1","anchor",cp)
            enqueue_checkpoint_bootstraps(store); store.ensure_jobs(); job=store.claim_job()
            store.finish_job(job["id"], {"decision":"continue","actions":[]}); cp2=dict(cp); cp2["revision"]=99; store.update_checkpoint("p1",cp2)
            self.assertFalse(enqueue_checkpoint_bootstraps(store)[0]["inserted"])
            self.assertEqual(store.counts()["events"],1); store.close()

    def test_complete_checkpoint_does_not_bootstrap(self):
        with tempfile.TemporaryDirectory() as tmp:
            store=BrowserlessStore(str(Path(tmp)/"core.sqlite3")); store.register_project("p1","2026-09-04-v1","anchor",checkpoint(stage="complete"))
            self.assertEqual(enqueue_checkpoint_bootstraps(store),[])
            self.assertEqual(store.counts()["events"],0); store.close()

class BootstrapQuiescenceTest(unittest.TestCase):
    def make_store(self, tmp):
        store = BrowserlessStore(str(Path(tmp) / "core.sqlite3"))
        store.register_project("p1", "2026-09-04-v1", "anchor", checkpoint())
        return store

    def finish_decision(self, store, decision, actions=None):
        store.enqueue_event("p1", f"seed-{decision}", "operator.task", {"summary":"seed","material":{},"metadata":{},"evidence":[]})
        store.ensure_jobs(); job = store.claim_job()
        store.finish_job(job["id"], {"decision": decision, "actions": actions or []})

    def test_external_wait_decisions_do_not_bootstrap_without_new_event(self):
        for decision in ("wait", "user_action_required", "escalation_required"):
            with self.subTest(decision=decision), tempfile.TemporaryDirectory() as tmp:
                store = self.make_store(tmp); self.finish_decision(store, decision)
                before = store.counts()["events"]
                self.assertEqual(enqueue_checkpoint_bootstraps(store), [])
                self.assertEqual(store.counts()["events"], before)
                store.close()

    def test_continue_without_unfinished_work_still_bootstraps(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self.make_store(tmp); self.finish_decision(store, "continue")
            result = enqueue_checkpoint_bootstraps(store)
            self.assertEqual(len(result), 1); self.assertTrue(result[0]["inserted"])
            store.close()

    def test_fresh_pending_event_prevents_duplicate_bootstrap_and_still_queues(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self.make_store(tmp); self.finish_decision(store, "continue")
            store.enqueue_event("p1", "fresh-event", "operator.task", {"summary":"fresh","material":{},"metadata":{},"evidence":[]})
            before = store.counts()["events"]
            self.assertEqual(enqueue_checkpoint_bootstraps(store), [])
            self.assertEqual(store.counts()["events"], before)
            self.assertEqual(store.ensure_jobs(), 1)
            self.assertIsNotNone(store.claim_job())
            store.close()


    def test_pending_and_running_jobs_prevent_bootstrap_even_without_pending_event(self):
        for running in (False, True):
            with self.subTest(running=running), tempfile.TemporaryDirectory() as tmp:
                store = self.make_store(tmp)
                store.enqueue_event("p1", "job-only", "operator.task", {"summary":"x","material":{},"metadata":{},"evidence":[]})
                store.ensure_jobs()
                if running:
                    job = store.claim_job(); self.assertIsNotNone(job)
                store.db.execute("UPDATE events SET status='done' WHERE event_key='job-only'")
                self.assertEqual(enqueue_checkpoint_bootstraps(store), [])
                store.close()

    def test_wait_checkpoint_still_processes_fresh_external_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self.make_store(tmp); self.finish_decision(store, "wait")
            store.enqueue_event("p1", "fresh-after-wait", "observation.github", {"summary":"fresh","material":{},"metadata":{},"evidence":[]})
            before = store.counts()["events"]
            self.assertEqual(enqueue_checkpoint_bootstraps(store), [])
            self.assertEqual(store.counts()["events"], before)
            self.assertEqual(store.ensure_jobs(), 1)
            job = store.claim_job(); self.assertEqual(job["kind"], "observation.github")
            store.close()

    def test_planned_and_running_actions_prevent_bootstrap(self):
        for claim in (False, True):
            with self.subTest(running=claim), tempfile.TemporaryDirectory() as tmp:
                store = self.make_store(tmp)
                action = {"type":"github.read","target":"repo:issue:1","purpose":"read","payload":""}
                self.finish_decision(store, "continue", [action])
                if claim:
                    self.assertIsNotNone(store.claim_action())
                self.assertEqual(enqueue_checkpoint_bootstraps(store), [])
                store.close()
    def test_latest_blocked_job_quiesces_reboot_bootstrap(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self.make_store(tmp); self.finish_decision(store, "continue")
            store.enqueue_event("p1", "budget-block", "operator.task", {"summary":"x","material":{},"metadata":{},"evidence":[]})
            store.ensure_jobs(); job=store.claim_job(); self.assertIsNotNone(job)
            store.block_job(job["id"], "monthly_budget_exhausted")
            self.assertEqual(store.latest_job_state("p1")["status"], "blocked")
            before=store.counts()["events"]
            self.assertEqual(enqueue_checkpoint_bootstraps(store), [])
            self.assertEqual(store.counts()["events"], before)
            store.close()

    def test_new_done_continue_after_blocked_job_reenables_bootstrap(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self.make_store(tmp); self.finish_decision(store, "continue")
            store.enqueue_event("p1", "budget-block", "operator.task", {"summary":"x","material":{},"metadata":{},"evidence":[]})
            store.ensure_jobs(); blocked=store.claim_job(); store.block_job(blocked["id"], "monthly_budget_exhausted")
            store.enqueue_event("p1", "fresh-recovery", "operator.task", {"summary":"fresh","material":{},"metadata":{},"evidence":[]})
            store.ensure_jobs(); recovered=store.claim_job(); self.assertIsNotNone(recovered)
            store.finish_job(recovered["id"], {"decision":"continue","actions":[]})
            result=enqueue_checkpoint_bootstraps(store)
            self.assertEqual(len(result),1); self.assertTrue(result[0]["inserted"])
            store.close()

    def test_fresh_event_after_blocked_job_queues_without_bootstrap(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self.make_store(tmp); self.finish_decision(store, "continue")
            store.enqueue_event("p1", "budget-block", "operator.task", {"summary":"x","material":{},"metadata":{},"evidence":[]})
            store.ensure_jobs(); blocked=store.claim_job(); store.block_job(blocked["id"], "monthly_budget_exhausted")
            store.enqueue_event("p1", "fresh-after-block", "observation.github", {"summary":"fresh","material":{},"metadata":{},"evidence":[]})
            self.assertEqual(enqueue_checkpoint_bootstraps(store), [])
            self.assertEqual(store.ensure_jobs(),1)
            job=store.claim_job(); self.assertEqual(job["kind"],"observation.github")
            store.close()
