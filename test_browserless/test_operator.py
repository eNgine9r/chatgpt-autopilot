import tempfile
import unittest
from pathlib import Path

from src.browserless.operator import enqueue_operator_task
from src.browserless.store import BrowserlessStore


class OperatorTaskTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.store=BrowserlessStore(str(Path(self.tmp.name)/"core.sqlite3"))
        self.store.register_project("p1","2026-09-04-v1","anchor",{})
    def tearDown(self):
        self.store.close(); self.tmp.cleanup()

    def test_same_request_id_is_idempotent(self):
        self.assertTrue(enqueue_operator_task(self.store,"p1","continue","req-1")["inserted"])
        self.assertFalse(enqueue_operator_task(self.store,"p1","continue","req-1")["inserted"])
        self.assertEqual(self.store.counts()["events"],1)

    def test_same_task_without_request_id_is_deduplicated(self):
        self.assertTrue(enqueue_operator_task(self.store,"p1","continue")["inserted"])
        self.assertFalse(enqueue_operator_task(self.store,"p1","continue")["inserted"])

    def test_invalid_task_and_project_fail_closed(self):
        with self.assertRaises(ValueError): enqueue_operator_task(self.store,"p1","")
        with self.assertRaises(KeyError): enqueue_operator_task(self.store,"missing","x")
