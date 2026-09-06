import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import tempfile
import unittest
from pathlib import Path

from src.browserless.read_tools import ReadActionError, ReadToolExecutor, capability_manifest, load_tool_bindings


class ReadToolsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.git_root = root / "repo"; self.git_root.mkdir()
        self.evidence_root = root / "evidence"; self.evidence_root.mkdir()
        self.bindings = {"p1":{
            "github":{"repo":{"repository":"eNgine9r/chatgpt-autopilot","token":""}},
            "runtime":{"health":{"url":"http://127.0.0.1:9999/health"}},
            "git":{"repo":{"path":str(self.git_root)}},
            "evidence":{"release":{"root":str(self.evidence_root)}},
        }}

    def tearDown(self): self.tmp.cleanup()

    def action(self, kind, target):
        return {"project_id":"p1","type":kind,"target":target,"purpose":"test"}

    def test_github_read_builds_fixed_get_target_and_drops_issue_body(self):
        seen = {}
        def get(url, headers):
            seen.update(url=url, headers=headers)
            return {"number":107,"title":"Browserless","state":"open","state_reason":None,
                    "labels":[{"name":"reliability"}],"body":"private body should hash only"}
        result = ReadToolExecutor(self.bindings, github_get=get).execute(self.action("github.read","repo:issue:107"))
        self.assertEqual(seen["url"], "https://api.github.com/repos/eNgine9r/chatgpt-autopilot/issues/107")
        self.assertNotIn("Authorization", seen["headers"])
        self.assertNotIn("private body", str(result))
        self.assertEqual(len(result["data"]["body_sha256"]), 64)

    def test_github_read_via_gh_uses_fixed_get_and_minimal_env(self):
        bindings={"p1":{"github":{"private":{"repository":"owner/private-repo","token":"","use_gh_auth":True}},
                        "runtime":{},"git":{},"evidence":{}}}
        seen={}
        class Result:
            returncode=0; stderr=""
            stdout=json.dumps({"number":7,"title":"Private issue","state":"open","labels":[],"body":"secret body"})
        def runner(command, **kwargs):
            seen.update(command=command, kwargs=kwargs)
            return Result()
        previous=os.environ.get("OPENAI_API_KEY")
        os.environ["OPENAI_API_KEY"]="SHOULD_NOT_LEAK"
        try:
            result=ReadToolExecutor(bindings,gh_runner=runner).execute(self.action("github.read","private:issue:7"))
        finally:
            if previous is None: os.environ.pop("OPENAI_API_KEY",None)
            else: os.environ["OPENAI_API_KEY"]=previous
        self.assertEqual(seen["command"],["gh","api","--hostname","github.com","--method","GET","repos/owner/private-repo/issues/7"])
        self.assertFalse(seen["kwargs"]["check"]); self.assertNotIn("shell",seen["kwargs"])
        self.assertEqual(seen["kwargs"]["timeout"],15)
        env=seen["kwargs"]["env"]
        self.assertEqual(env["GH_HOST"],"github.com"); self.assertEqual(env["GH_PROMPT_DISABLED"],"1")
        self.assertEqual(env["GIT_TERMINAL_PROMPT"],"0"); self.assertNotIn("OPENAI_API_KEY",env)
        self.assertNotIn("secret body",str(result)); self.assertEqual(result["data"]["title"],"Private issue")

    def test_github_prfiles_is_bounded_and_drops_patch_sensitive_paths_and_raw_metadata(self):
        seen = {}
        raw = [
            {"filename":"src/app.py","status":"modified","additions":7,"deletions":2,"changes":9,"sha":"abc","patch":"@@ secret patch"},
            {"filename":"docs/readme.md","status":"renamed","previous_filename":"README.md","additions":1,"deletions":1,"changes":2,"patch":"@@"},
            {"filename":".env","status":"modified","additions":1,"deletions":0,"changes":1,"patch":"SECRET=1"},
        ]
        def get(url, headers): seen.update(url=url, headers=headers); return raw
        result=ReadToolExecutor(self.bindings,github_get=get).execute(self.action("github.read","repo:prfiles:351"))
        self.assertEqual(seen["url"],"https://api.github.com/repos/eNgine9r/chatgpt-autopilot/pulls/351/files?per_page=100")
        self.assertEqual(result["data"]["count"],2); self.assertFalse(result["data"]["truncated"])
        names=[item["filename"] for item in result["data"]["files"]]
        self.assertEqual(names,["src/app.py","docs/readme.md"]); self.assertNotIn(".env",names)
        encoded=json.dumps(result,sort_keys=True)
        self.assertNotIn("secret patch",encoded); self.assertNotIn("SECRET=1",encoded); self.assertNotIn('"sha"',encoded); self.assertNotIn('"patch"',encoded)

    def test_github_prfiles_via_gh_uses_fixed_read_endpoint_and_accepts_list_json(self):
        bindings={"p1":{"github":{"private":{"repository":"owner/private-repo","token":"","use_gh_auth":True}},
                        "runtime":{},"git":{},"evidence":{}}}
        seen={}
        class Result:
            returncode=0; stderr=""
            stdout=json.dumps([{"filename":"src/a.py","status":"added","additions":3,"deletions":0,"changes":3,"patch":"hidden"}])
        def runner(command,**kwargs): seen.update(command=command,kwargs=kwargs); return Result()
        result=ReadToolExecutor(bindings,gh_runner=runner).execute(self.action("github.read","private:prfiles:12"))
        self.assertEqual(seen["command"],["gh","api","--hostname","github.com","--method","GET","repos/owner/private-repo/pulls/12/files?per_page=100"])
        self.assertEqual(result["data"]["files"][0]["filename"],"src/a.py")
        self.assertNotIn("hidden",json.dumps(result))

    def test_github_read_via_gh_fails_closed_on_process_or_json_error(self):
        bindings={"p1":{"github":{"private":{"repository":"owner/private-repo","token":"","use_gh_auth":True}},
                        "runtime":{},"git":{},"evidence":{}}}
        class Failed: returncode=1; stdout=""; stderr="auth"
        with self.assertRaises(ReadActionError) as ctx:
            ReadToolExecutor(bindings,gh_runner=lambda *_a,**_k:Failed()).execute(self.action("github.read","private:issue:7"))
        self.assertEqual(ctx.exception.code,"github_read_failed")
        class Invalid: returncode=0; stdout="not-json"; stderr=""
        with self.assertRaises(ReadActionError) as ctx:
            ReadToolExecutor(bindings,gh_runner=lambda *_a,**_k:Invalid()).execute(self.action("github.read","private:issue:7"))
        self.assertEqual(ctx.exception.code,"github_invalid_json")

    def test_github_target_cannot_be_arbitrary_url_or_write_resource(self):
        executor = ReadToolExecutor(self.bindings, github_get=lambda *_: {})
        for target in ("https://evil.example/x", "repo:issues:107/comments", "repo:write:107", "other:issue:1"):
            with self.assertRaises(ReadActionError, msg=target): executor.execute(self.action("github.read",target))

    def test_runtime_read_is_alias_only_and_sanitizes_metrics(self):
        seen = {}
        def get(url, headers):
            seen["url"] = url
            return {"status":"healthy","version":"1","cpu":99,"memory_mb":500,"uptime":999}
        result = ReadToolExecutor(self.bindings, runtime_get=get).execute(self.action("runtime.read","health"))
        self.assertEqual(seen["url"], "http://127.0.0.1:9999/health")
        self.assertEqual(result["data"]["status"], "healthy")
        self.assertNotIn("cpu", result["data"]); self.assertNotIn("uptime", result["data"])
        with self.assertRaises(ReadActionError):
            ReadToolExecutor(self.bindings, runtime_get=get).execute(self.action("runtime.read","http://evil"))

    def test_git_read_uses_only_fixed_operation_arguments(self):
        seen = {}
        def run(root, args): seen.update(root=root,args=args); return "abc123\n"
        result = ReadToolExecutor(self.bindings, git_run=run).execute(self.action("git.read","repo:head"))
        self.assertEqual(seen["root"], str(self.git_root)); self.assertEqual(seen["args"],["rev-parse","HEAD"])
        self.assertEqual(result["output"], "abc123\n")
        with self.assertRaises(ReadActionError):
            ReadToolExecutor(self.bindings, git_run=run).execute(self.action("git.read","repo:reset:hard"))

    def test_evidence_read_stays_under_root_and_redacts_secret_keys(self):
        file = self.evidence_root / "proof.json"
        file.write_text(json.dumps({"commit":"abc","api_key":"secret-value","nested":{"password":"pw","ok":True}}))
        result = ReadToolExecutor(self.bindings).execute(self.action("evidence.read","release:proof.json"))
        self.assertEqual(result["content"]["commit"], "abc")
        self.assertEqual(result["content"]["api_key"], "[REDACTED]")
        self.assertEqual(result["content"]["nested"]["password"], "[REDACTED]")
        self.assertNotIn("secret-value", str(result))
        with self.assertRaises(ReadActionError):
            ReadToolExecutor(self.bindings).execute(self.action("evidence.read","release:../escape.json"))

    def test_default_runtime_reader_does_not_follow_redirects(self):
        class RedirectHandler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_GET(self):
                if self.path == "/health":
                    self.send_response(302); self.send_header("Location", "/redirected"); self.end_headers()
                else:
                    body=b'{"status":"healthy"}'; self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
        server=HTTPServer(("127.0.0.1",0),RedirectHandler); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        try:
            port=server.server_address[1]
            bindings={"p1":{"github":{},"runtime":{"health":{"url":f"http://127.0.0.1:{port}/health"}},"git":{},"evidence":{}}}
            with self.assertRaises(ReadActionError) as ctx:
                ReadToolExecutor(bindings).execute(self.action("runtime.read","health"))
            self.assertEqual(ctx.exception.code,"runtime_read_failed")
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_unknown_or_non_read_action_fails_closed(self):
        executor = ReadToolExecutor(self.bindings)
        with self.assertRaises(ReadActionError): executor.execute(self.action("browser.navigate","x"))
        with self.assertRaises(ReadActionError): executor.execute({"project_id":"missing","type":"git.read","target":"repo:head"})


class ToolBindingTest(unittest.TestCase):
    def test_config_rejects_non_loopback_runtime_and_missing_token(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)/"tools.json"
            p.write_text(json.dumps({"projects":{"p":{"runtime":{"x":{"url":"https://example.com/health"}}}}}))
            with self.assertRaises(ValueError): load_tool_bindings(p,{})
            p.write_text(json.dumps({"projects":{"p":{"github":{"r":{"repository":"o/r","tokenEnv":"GH_TOKEN"}}}}}))
            with self.assertRaises(ValueError): load_tool_bindings(p,{})
            loaded = load_tool_bindings(p,{"GH_TOKEN":"dummy"})
            self.assertEqual(loaded["p"]["github"]["r"]["repository"], "o/r")
            self.assertNotIn("dummy", json.dumps({"repository":loaded["p"]["github"]["r"]["repository"]}))
            p.write_text(json.dumps({"projects":{"p":{"github":{"r":{"repository":"o/r","useGhAuth":True}}}}}))
            loaded = load_tool_bindings(p,{})
            self.assertTrue(loaded["p"]["github"]["r"]["use_gh_auth"]); self.assertEqual(loaded["p"]["github"]["r"]["token"],"")
            p.write_text(json.dumps({"projects":{"p":{"github":{"r":{"repository":"o/r","tokenEnv":"GH_TOKEN","useGhAuth":True}}}}}))
            with self.assertRaises(ValueError): load_tool_bindings(p,{"GH_TOKEN":"dummy"})

    def test_capability_manifest_exposes_grammar_not_secrets_or_local_targets(self):
        bindings={"p":{
            "github":{"gh":{"repository":"owner/private-repo","token":"TOP_SECRET_TOKEN"}},
            "runtime":{"health":{"url":"http://127.0.0.1:9999/secret-health"}},
            "git":{"local":{"path":"/very/private/repo"}},
            "evidence":{"release":{"root":"/private/evidence"}},
            "repo":{"work":{"path":"/private/repo","workspace_root":"/private/workspaces",
                "base_branch":"main","write_enabled":True,"write_paths":["src/browserless/"],
                "tests":{"unit":["python3","-m","unittest"]},"test_timeout":30,
                "publish_repository":"owner/private-repo"}}}}
        manifest=capability_manifest(bindings)["p"]
        text=json.dumps(manifest,sort_keys=True)
        self.assertIn("repo.patch",text); self.assertIn("<repo-alias>",text)
        self.assertIn(":lines:<start>:<count 1-200>:",manifest["syntax"]["repo.read"])
        self.assertIn("lines",manifest["repo"]["work"]["readModes"])
        self.assertIn("prfiles",manifest["syntax"]["github.read"])
        self.assertEqual(manifest["aliases"]["github"],["gh"])
        self.assertEqual(manifest["repo"]["work"]["testAliases"],["unit"])
        self.assertEqual(manifest["repo"]["work"]["requiredTestAliases"],["unit"])
        self.assertEqual(manifest["repo"]["work"]["writePaths"],["src/browserless/"])
        self.assertTrue(manifest["repo"]["work"]["publishEnabled"])
        for secret in ("TOP_SECRET_TOKEN","/very/private/repo","secret-health","/private/evidence","owner/private-repo"):
            self.assertNotIn(secret,text)

class CapabilityPatchGrammarTest(unittest.TestCase):
    def test_patch_capability_exposes_exact_git_diff_grammar(self):
        from src.browserless.read_tools import capability_manifest
        manifest=capability_manifest({"p":{"github":{},"runtime":{},"git":{},"evidence":{},"repo":{}}})
        grammar=manifest["p"]["syntax"]["repo.patch"]
        self.assertIn("diff --git a/<path> b/<path>",grammar)
        self.assertIn("--- a/<path>",grammar); self.assertIn("+++ b/<path>",grammar)
        self.assertIn("no Markdown fences",grammar)

class RepoAliasManifestTest(unittest.TestCase):
    def test_repo_alias_is_explicitly_listed_for_luna(self):
        from src.browserless.read_tools import capability_manifest
        manifest=capability_manifest({"p":{"github":{},"runtime":{},"git":{},"evidence":{},"repo":{"shadow":{"write_enabled":True,"write_paths":["x.txt"],"tests":{},"publish_repository":"x/y"}}}})
        self.assertEqual(manifest["p"]["aliases"]["repo"],["shadow"])
        self.assertIn("shadow",manifest["p"]["repo"])
