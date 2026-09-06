import json
import tempfile
import unittest
from pathlib import Path

from src.browserless.store import BrowserlessStore
from src.browserless.supervisor import run_once


class NeverClient:
    def decide(self, *_args, **_kwargs):
        raise AssertionError("idle supervisor must not call Luna")


class NeverExecutor:
    def execute(self, *_args, **_kwargs):
        raise AssertionError("idle supervisor must not perform external reads")


class SupervisorTest(unittest.TestCase):
    def test_idle_run_makes_zero_ai_and_external_reads(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = BrowserlessStore(str(Path(tmp) / "core.sqlite3"))
            try:
                store.register_project("p1", "2026-09-04-v1", "anchor", {})
                result = run_once(store, NeverClient(), NeverExecutor(), type("G", (), {"preflight": lambda *_: {"allowed": True}})())
                self.assertEqual(result["ai"], {"status": "idle", "api_called": False})
                self.assertEqual(result["action"], {"status": "idle", "external_read": False})
            finally:
                store.close()
