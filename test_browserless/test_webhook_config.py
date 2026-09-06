import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from src.browserless.webhook_config import WebhookConfigError, load_plan, reconcile, EVENTS


class FakeRunner:
    def __init__(self, existing=None):
        self.existing = existing or []
        self.calls = []
    def __call__(self, command, input=None, text=None, capture_output=None, check=None):
        self.calls.append((list(command), input))
        if command[:2] == ["gh", "api"] and len(command) == 3:
            return SimpleNamespace(returncode=0, stdout=json.dumps(self.existing), stderr="")
        if "--method" in command:
            method = command[command.index("--method") + 1]
            if method == "POST": return SimpleNamespace(returncode=0, stdout='{"id":123}', stderr="")
            if method == "PATCH": return SimpleNamespace(returncode=0, stdout='{"id":77}', stderr="")
        return SimpleNamespace(returncode=1, stdout="", stderr="bad")


class WebhookConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.bindings = Path(self.tmp.name) / "bindings.json"
        self.bindings.write_text(json.dumps({"github":{"p1":{"repository":"eNgine9r/chatgpt-autopilot","secretEnv":"HOOK_SECRET"}}}))
        self.env = Path(self.tmp.name) / ".env.local"
        self.env.write_text("HOOK_SECRET=" + "a" * 64 + "\n")
        os.chmod(self.env, 0o600)
    def tearDown(self): self.tmp.cleanup()

    def test_plan_is_https_and_contains_expected_callback(self):
        plan = load_plan(self.bindings, "https://example.test/autopilot-events/")
        self.assertEqual(plan[0]["callback"], "https://example.test/autopilot-events/v1/github/p1")
        with self.assertRaises(WebhookConfigError): load_plan(self.bindings, "http://example.test/events")

    def test_create_uses_stdin_and_never_places_secret_in_argv(self):
        plan = load_plan(self.bindings, "https://example.test/autopilot-events")
        runner = FakeRunner()
        result = reconcile(plan, self.env, runner)
        self.assertEqual(result[0]["action"], "created")
        self.assertEqual(result[0]["hook_id"], 123)
        secret = "a" * 64
        self.assertTrue(all(secret not in " ".join(cmd) for cmd, _ in runner.calls))
        post_body = json.loads(runner.calls[-1][1])
        self.assertEqual(post_body["config"]["secret"], secret)
        self.assertEqual(post_body["events"], EVENTS)

    def test_existing_exact_callback_is_updated_not_duplicated(self):
        callback = "https://example.test/autopilot-events/v1/github/p1"
        runner = FakeRunner([{"id":77,"config":{"url":callback}}])
        result = reconcile(load_plan(self.bindings, "https://example.test/autopilot-events"), self.env, runner)
        self.assertEqual(result[0]["action"], "updated")
        self.assertIn("repos/eNgine9r/chatgpt-autopilot/hooks/77", runner.calls[-1][0])

    def test_env_file_permissions_and_secret_length_fail_closed(self):
        plan = load_plan(self.bindings, "https://example.test/autopilot-events")
        os.chmod(self.env, 0o644)
        with self.assertRaises(WebhookConfigError): reconcile(plan, self.env, FakeRunner())
        os.chmod(self.env, 0o600); self.env.write_text("HOOK_SECRET=short\n")
        with self.assertRaises(WebhookConfigError): reconcile(plan, self.env, FakeRunner())
