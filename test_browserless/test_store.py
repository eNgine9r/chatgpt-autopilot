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
