import unittest

from src.browserless.actions import READ_ONLY_ACTION_TYPES, WORKSPACE_ACTION_TYPES, SAFE_ACTION_TYPES, validate_actions


def action(kind, target="x", purpose="test", payload=""):
    return {"type":kind,"target":target,"purpose":purpose,"payload":payload}


class ActionContractTest(unittest.TestCase):
    def test_v1_contract_contains_only_safe_evidence_and_workspace_actions(self):
        self.assertEqual(READ_ONLY_ACTION_TYPES, ("github.read", "runtime.read", "git.read", "evidence.read", "repo.read"))
        self.assertEqual(WORKSPACE_ACTION_TYPES, ("repo.prepare", "repo.patch", "repo.test", "repo.commit", "repo.publish"))
        self.assertEqual(SAFE_ACTION_TYPES, READ_ONLY_ACTION_TYPES + WORKSPACE_ACTION_TYPES)
        self.assertEqual(validate_actions([action("repo.prepare","autopilot","isolated workspace")])[0]["type"], "repo.prepare")

    def test_workspace_action_must_be_single_step(self):
        with self.assertRaises(ValueError):
            validate_actions([action("repo.prepare","autopilot","prepare"), action("repo.test","autopilot:browserless","test")])

    def test_patch_requires_bounded_payload_and_other_actions_forbid_payload(self):
        diff="diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+new\n"
        normalized=validate_actions([action("repo.patch","autopilot","change",diff)])
        self.assertEqual(normalized[0]["payload"],diff)
        with self.assertRaises(ValueError): validate_actions([action("repo.patch","autopilot","change","")])
        with self.assertRaises(ValueError): validate_actions([action("repo.read","autopilot:tree","read","extra")])
        with self.assertRaises(ValueError): validate_actions([action("repo.patch","autopilot","change","x"*20001)])
        self.assertEqual(validate_actions([action("repo.commit","autopilot","commit")])[0]["payload"],"")
        self.assertEqual(validate_actions([action("repo.publish","autopilot","publish")])[0]["payload"],"")

    def test_mutating_or_browser_actions_fail_closed(self):
        for kind in ("repo.push", "github.write", "runtime.restart", "trading.execute", "hardware.write", "modbus.write", "browser.navigate", "deploy.execute"):
            with self.assertRaises(ValueError, msg=kind): validate_actions([action(kind)])
