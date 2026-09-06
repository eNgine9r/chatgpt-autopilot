import hashlib
import hmac
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from src.browserless.ingress_server import create_server, load_bindings
from src.browserless.store import BrowserlessStore

GH_SECRET = b"github-test-secret"
RT_SECRET = b"runtime-test-secret"


def signature(secret, body):
    return "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()


class IngressServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "core.sqlite3")
        store = BrowserlessStore(self.db)
        store.register_project("p1", "2026-09-04-v1", "anchor", {})
        store.close()
        bindings = {"github":{"p1":{"repository":"eNgine9r/chatgpt-autopilot","secret":GH_SECRET}},
                    "runtime":{"p1":{"components":{"api"},"secret":RT_SECRET}}}
        self.server = create_server(self.db, bindings, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host, self.port = self.server.server_address

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)
        self.tmp.cleanup()

    def request(self, method, path, payload=None, headers=None):
        body = b"" if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        hdr = {"Content-Type":"application/json", **(headers or {})}
        conn = http.client.HTTPConnection(self.host, self.port, timeout=2)
        conn.request(method, path, body=body if method == "POST" else None, headers=hdr)
        response = conn.getresponse(); data = json.loads(response.read().decode()); conn.close()
        return response.status, data

    def github_payload(self, conclusion="success"):
        return {"repository":{"full_name":"eNgine9r/chatgpt-autopilot"}, "workflow_run":{
            "id":1,"workflow_id":7,"name":"CI","status":"completed","conclusion":conclusion,
            "head_sha":"abc","head_branch":"main","run_number":1,"run_attempt":1,"event":"pull_request"}}

    def test_health_is_read_only(self):
        status, data = self.request("GET", "/health")
        self.assertEqual(status, 200); self.assertTrue(data["ok"])
        self.assertEqual(data["events"], 0)

    def test_valid_github_webhook_deduplicates_without_creating_jobs(self):
        payload = self.github_payload(); body = json.dumps(payload, separators=(",", ":")).encode()
        headers = {"X-Hub-Signature-256":signature(GH_SECRET, body), "X-GitHub-Event":"workflow_run"}
        first = self.request("POST", "/v1/github/p1", payload, headers)
        second = self.request("POST", "/v1/github/p1", payload, headers)
        self.assertEqual(first[0], 202); self.assertTrue(first[1]["changed"])
        self.assertEqual(second[0], 200); self.assertFalse(second[1]["changed"])
        store = BrowserlessStore(self.db)
        try:
            self.assertEqual(store.counts()["events"], 1)
            self.assertEqual(store.counts()["jobs"], 0)
            self.assertEqual(store.counts()["planned_actions"], 0)
        finally: store.close()

    def test_signature_and_repository_mismatch_fail_closed(self):
        payload = self.github_payload(); body = json.dumps(payload, separators=(",", ":")).encode()
        bad = self.request("POST", "/v1/github/p1", payload,
                           {"X-Hub-Signature-256":"sha256=bad","X-GitHub-Event":"workflow_run"})
        self.assertEqual(bad[0], 401)
        payload["repository"]["full_name"] = "other/repo"
        body = json.dumps(payload, separators=(",", ":")).encode()
        wrong_repo = self.request("POST", "/v1/github/p1", payload,
                                  {"X-Hub-Signature-256":signature(GH_SECRET, body),"X-GitHub-Event":"workflow_run"})
        self.assertEqual(wrong_repo[0], 403)

    def test_runtime_metrics_noise_deduplicates_and_component_is_allowlisted(self):
        payload = {"component":"api","status":"healthy","version":"1","cpu":99,"uptime":10}
        body = json.dumps(payload, separators=(",", ":")).encode()
        headers = {"X-Autopilot-Signature-256":signature(RT_SECRET, body)}
        self.assertEqual(self.request("POST", "/v1/runtime/p1", payload, headers)[0], 202)
        payload["cpu"] = 1; payload["uptime"] = 999
        body = json.dumps(payload, separators=(",", ":")).encode()
        headers = {"X-Autopilot-Signature-256":signature(RT_SECRET, body)}
        response = self.request("POST", "/v1/runtime/p1", payload, headers)
        self.assertEqual(response[0], 200); self.assertFalse(response[1]["changed"])
        payload["component"] = "not-allowed"; body = json.dumps(payload, separators=(",", ":")).encode()
        headers = {"X-Autopilot-Signature-256":signature(RT_SECRET, body)}
        self.assertEqual(self.request("POST", "/v1/runtime/p1", payload, headers)[0], 403)

    def test_unsupported_github_event_fails_without_creating_event(self):
        payload = {"repository":{"full_name":"eNgine9r/chatgpt-autopilot"},"ref":"refs/heads/main"}
        body = json.dumps(payload, separators=(",", ":")).encode()
        response = self.request("POST", "/v1/github/p1", payload,
                                {"X-Hub-Signature-256":signature(GH_SECRET, body),"X-GitHub-Event":"push"})
        self.assertEqual(response[0], 422)
        store = BrowserlessStore(self.db)
        try: self.assertEqual(store.counts()["events"], 0)
        finally: store.close()

    def test_oversized_body_is_rejected_before_signature_or_json_work(self):
        conn = http.client.HTTPConnection(self.host, self.port, timeout=2)
        body = b"x" * 262145
        conn.request("POST", "/v1/runtime/p1", body=body, headers={"Content-Type":"application/json"})
        response = conn.getresponse(); data = json.loads(response.read().decode()); conn.close()
        self.assertEqual(response.status, 413)
        self.assertEqual(data["error"], "body_too_large")

    def test_unknown_binding_and_non_loopback_bind_fail_closed(self):
        self.assertEqual(self.request("POST", "/v1/github/missing", {}, {})[0], 404)
        with self.assertRaises(ValueError):
            create_server(self.db, {"github":{},"runtime":{}}, host="0.0.0.0", port=0)
        with self.assertRaises(ValueError):
            create_server(self.db, {"github":{"p2":{"repository":"o/r","secret":b"x"}},"runtime":{}}, port=0)


class BindingConfigTest(unittest.TestCase):
    def test_binding_secrets_are_resolved_only_from_environment(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)/"bindings.json"
            p.write_text(json.dumps({"github":{"p":{"repository":"o/r","secretEnv":"GH"}},
                                     "runtime":{"p":{"components":["api"],"secretEnv":"RT"}}}))
            result = load_bindings(p, {"GH":"g-secret","RT":"r-secret"})
            self.assertEqual(result["github"]["p"]["secret"], b"g-secret")
            self.assertEqual(result["runtime"]["p"]["secret"], b"r-secret")
            with self.assertRaises(ValueError): load_bindings(p, {"GH":"g-secret"})
