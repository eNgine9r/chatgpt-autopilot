import json
import tempfile
import unittest
from unittest.mock import patch
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
    def test_run_once_passes_production_github_quiet_window(self):
        seen = {}
        store = object()
        with patch("src.browserless.supervisor.process_once") as proc, patch("src.browserless.supervisor.execute_action_once") as act:
            proc.side_effect = lambda *args, **kwargs: seen.update(kwargs) or {"status":"idle"}
            act.return_value = {"status":"idle"}
            result = run_once(store, object(), object(), object(), {}, 15)
        self.assertEqual(result["ai"]["status"],"idle")
        self.assertEqual(seen["github_quiet_seconds"],15)

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
