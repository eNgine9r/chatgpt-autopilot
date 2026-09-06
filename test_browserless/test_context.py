import unittest
from src.browserless.context import compile_context


class ContextTest(unittest.TestCase):
    def test_unbounded_history_and_raw_logs_are_excluded(self):
        project = {"id":"p", "plan_version":"2026-09-04-v1", "plan_anchor":"ANCHOR", "checkpoint":{"goal":"g"}}
        event = {"kind":"runtime", "payload":{"summary":"fresh", "evidence":["ok"], "chat_history":"SECRET_HISTORY", "raw_log":"RAW_LOG"}}
        text = compile_context(project, event)
        self.assertIn("ANCHOR", text)
        self.assertIn("fresh", text)
        self.assertIn("ok", text)
        self.assertNotIn("SECRET_HISTORY", text)
        self.assertNotIn("RAW_LOG", text)

    def test_evidence_is_bounded(self):
        project = {"id":"p", "plan_version":"2026-09-04-v1", "plan_anchor":"A", "checkpoint":{}}
        evidence = ["x" * 2000 for _ in range(30)]
        text = compile_context(project, {"kind":"e", "payload":{"evidence":evidence}})
        self.assertLess(len(text), 26000)

    def test_material_observation_is_included_but_bounded(self):
        project = {"id":"p","plan_version":"2026-09-04-v1","plan_anchor":"anchor","checkpoint":{}}
        event = {"kind":"observation.github","payload":{"material":{"status":"success","sha":"a"*5000}}}
        context = compile_context(project, event)
        self.assertIn('"status":"success"', context)
        self.assertLess(len(context), 20000)
        self.assertNotIn("a" * 1500, context)

    def test_sanitized_capabilities_are_in_stable_context(self):
        project={"id":"p","plan_version":"2026-09-04-v1","plan_anchor":"A","checkpoint":{}}
        caps={"syntax":{"repo.test":"<repo-alias>:<test-alias>"},"repo":{"work":{"testAliases":["unit"]}}}
        text=compile_context(project,{"kind":"e","payload":{}},caps)
        self.assertIn('\"capabilities\"',text)
        self.assertIn('repo.test',text); self.assertIn('unit',text)
