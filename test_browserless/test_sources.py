import unittest

from src.browserless.sources import github_observation, runtime_observation


class SourceNormalizationTest(unittest.TestCase):
    def test_workflow_run_keeps_state_but_drops_large_github_payload(self):
        subject, doc = github_observation("workflow_run", {"workflow_run":{
            "id":12,"workflow_id":9,"name":"CI","status":"completed","conclusion":"success",
            "head_sha":"abc","head_branch":"main","run_number":4,"run_attempt":1,"event":"pull_request",
            "repository":{"huge":"ignored"},"logs_url":"ignored"}})
        self.assertEqual(subject, "workflow:9:abc")
        self.assertEqual(doc["material"]["conclusion"], "success")
        self.assertNotIn("repository", doc["material"])
        self.assertNotIn("logs_url", doc["material"])

    def test_pull_request_normalization_is_bounded_and_identity_stable(self):
        subject, doc = github_observation("pull_request", {"action":"closed","number":108,"pull_request":{
            "state":"closed","merged":True,"draft":False,"merge_commit_sha":"m",
            "head":{"sha":"h"},"base":{"sha":"b"},"body":"ignored"}})
        self.assertEqual(subject, "pr:108")
        self.assertTrue(doc["material"]["merged"])
        self.assertNotIn("body", doc["material"])

    def test_runtime_ignores_metrics_and_keeps_material_health(self):
        subject, doc = runtime_observation({"component":"api","status":"healthy","version":"1.2",
                                            "cpu":93.2,"memory_mb":999,"uptime":10,"flags":{"ready":1}})
        self.assertEqual(subject, "component:api")
        self.assertEqual(doc["material"]["status"], "healthy")
        self.assertNotIn("cpu", doc["material"])
        self.assertNotIn("memory_mb", doc["material"])
        self.assertNotIn("uptime", doc["material"])

    def test_issue_comment_body_is_hashed_not_copied(self):
        secretish = "sensitive comment body that should not be copied"
        subject, doc = github_observation("issue_comment", {"action":"created","issue":{"number":107},
            "comment":{"id":55,"body":secretish,"user":{"login":"u"}}})
        self.assertEqual(subject, "issue:107:comment:55")
        self.assertNotIn("body", doc["material"])
        self.assertEqual(len(doc["material"]["body_sha256"]), 64)
        self.assertNotIn(secretish, str(doc))

    def test_runtime_raw_error_and_evidence_are_not_forwarded(self):
        _, doc = runtime_observation({"component":"api","status":"degraded","error":"token=secret",
                                      "error_code":"E_CONN","evidence":["raw secret log"],
                                      "safe_evidence":["health endpoint returned degraded"]})
        self.assertNotIn("error", doc["material"])
        self.assertEqual(doc["material"]["error_code"], "E_CONN")
        self.assertEqual(doc["evidence"], ["health endpoint returned degraded"] )
        self.assertNotIn("raw secret log", str(doc))

    def test_unknown_github_or_empty_runtime_fails_closed(self):
        with self.assertRaises(ValueError): github_observation("push", {})
        with self.assertRaises(ValueError): runtime_observation({"component":"api","cpu":1})
