import unittest

from src.browserless.actions import READ_ONLY_ACTION_TYPES, validate_actions


class ActionContractTest(unittest.TestCase):
    def test_v1_contract_contains_only_read_only_evidence_actions(self):
        self.assertEqual(READ_ONLY_ACTION_TYPES, ("github.read", "runtime.read", "git.read", "evidence.read"))
        self.assertEqual(validate_actions([{"type":"runtime.read","target":"nexolab:/health","purpose":"fresh health"}])[0]["type"], "runtime.read")

    def test_mutating_or_browser_actions_fail_closed(self):
        for kind in ("github.write", "runtime.restart", "trading.execute", "hardware.write", "modbus.write", "browser.navigate"):
            with self.assertRaises(ValueError, msg=kind):
                validate_actions([{"type":kind,"target":"x","purpose":"x"}])
