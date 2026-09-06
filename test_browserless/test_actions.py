import unittest

from src.browserless.actions import READ_ONLY_ACTION_TYPES, WORKSPACE_ACTION_TYPES, SAFE_ACTION_TYPES, validate_actions


class ActionContractTest(unittest.TestCase):
    def test_v1_contract_contains_only_safe_evidence_and_workspace_actions(self):
        self.assertEqual(READ_ONLY_ACTION_TYPES, ("github.read", "runtime.read", "git.read", "evidence.read", "repo.read"))
        self.assertEqual(WORKSPACE_ACTION_TYPES, ("repo.prepare", "repo.test"))
        self.assertEqual(SAFE_ACTION_TYPES, READ_ONLY_ACTION_TYPES + WORKSPACE_ACTION_TYPES)
        self.assertEqual(validate_actions([{"type":"repo.prepare","target":"autopilot","purpose":"isolated workspace"}])[0]["type"], "repo.prepare")

    def test_mutating_or_browser_actions_fail_closed(self):
        for kind in ("repo.patch", "repo.commit", "repo.push", "github.write", "runtime.restart", "trading.execute", "hardware.write", "modbus.write", "browser.navigate", "deploy.execute"):
            with self.assertRaises(ValueError, msg=kind):
                validate_actions([{"type":kind,"target":"x","purpose":"x"}])
