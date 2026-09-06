import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from src.browserless.read_tools import ReadActionError, load_tool_bindings
from src.browserless.workspace_tools import WorkspaceToolExecutor


def git(*args, cwd=None):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


class FakeResult:
    def __init__(self, returncode=0, stdout="sandbox ok\n", stderr=""):
        self.returncode=returncode; self.stdout=stdout; self.stderr=stderr


class WorkspaceToolsTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); root=Path(self.tmp.name)
        self.repo=root/"repo"; self.repo.mkdir(); git("init","-b","main",cwd=self.repo)
        git("config","user.email","test@example.com",cwd=self.repo); git("config","user.name","Test",cwd=self.repo)
        (self.repo/"app.py").write_text("print('hello')\nneedle = 1\n")
        (self.repo/"README.md").write_text("tracked docs\n")
        git("add","app.py","README.md",cwd=self.repo); git("commit","-m","base",cwd=self.repo)
        self.remote=root/"remote.git"; git("init","--bare",str(self.remote)); git("remote","add","origin",str(self.remote),cwd=self.repo); git("push","-u","origin","main",cwd=self.repo)
        self.workspace_root=root/"workspaces"
        self.bindings={"p1":{"github":{},"runtime":{},"git":{},"evidence":{},"repo":{"autopilot":{
            "path":str(self.repo),"workspace_root":str(self.workspace_root),"base_branch":"main","write_enabled":True,
            "tests":{"unit":["python3","-c","print('ok')"]},"test_timeout":30}}}}

    def tearDown(self): self.tmp.cleanup()

    def action(self, kind, target, job_id=7):
        return {"id":1,"job_id":job_id,"project_id":"p1","type":kind,"target":target,"purpose":"test"}

    def test_repo_read_uses_only_tracked_files_and_literal_search(self):
        (self.repo/".env.local").write_text("DUMMY_PLACEHOLDER=not-a-secret\n")
        (self.repo/"untracked.py").write_text("private\n")
        ex=WorkspaceToolExecutor(self.bindings)
        file=ex.execute(self.action("repo.read","autopilot:file:app.py"))
        self.assertIn("needle",file["content"]); self.assertEqual(len(file["sha256"]),64)
        tree=ex.execute(self.action("repo.read","autopilot:tree"))
        self.assertIn("app.py",tree["files"]); self.assertNotIn(".env.local",tree["files"]); self.assertNotIn("untracked.py",tree["files"])
        search=ex.execute(self.action("repo.read","autopilot:search:needle"))
        self.assertIn("app.py",search["matches"])
        with self.assertRaises(ReadActionError): ex.execute(self.action("repo.read","autopilot:file:.env.local"))
        with self.assertRaises(ReadActionError): ex.execute(self.action("repo.read","autopilot:file:untracked.py"))

    def test_prepare_uses_remote_main_and_deterministic_workspace(self):
        canonical_before=git("rev-parse","HEAD",cwd=self.repo)
        ex=WorkspaceToolExecutor(self.bindings)
        result=ex.execute(self.action("repo.prepare","autopilot",job_id=12))
        remote_head=git("rev-parse","refs/heads/main",cwd=self.remote)
        self.assertEqual(result["base_sha"],remote_head)
        self.assertEqual(result["branch"],"autopilot/browserless/p1/job-12")
        self.assertEqual(git("rev-parse","HEAD",cwd=self.repo),canonical_before)
        self.assertTrue(Path(result["workspace"]).is_dir())
        reused=ex.execute(self.action("repo.prepare","autopilot",job_id=12))
        self.assertTrue(reused["reused"])

    def test_test_action_uses_bwrap_contract_and_no_secret_environment(self):
        ex=WorkspaceToolExecutor(self.bindings); ex.execute(self.action("repo.prepare","autopilot",job_id=21))
        seen={}
        def sandbox(argv, **kwargs):
            seen["argv"]=argv; seen["kwargs"]=kwargs
            return FakeResult()
        ex=WorkspaceToolExecutor(self.bindings,bwrap_path="/usr/bin/bwrap",sandbox_runner=sandbox)
        result=ex.execute(self.action("repo.test","autopilot:unit",job_id=21))
        argv=seen["argv"]
        self.assertIn("--unshare-all",argv); self.assertIn("--clearenv",argv)
        self.assertIn("--tmpfs",argv); self.assertIn("/home",argv)
        self.assertNotIn("OPENAI_API_KEY",argv)
        self.assertFalse(seen["kwargs"]["shell"]); self.assertTrue(result["passed"])

    def test_repo_search_filters_sensitive_tracked_filenames(self):
        sensitive = self.repo / ".env.example"
        sensitive.write_text("NEEDLE=secret\n")
        safe = self.repo / "safe.txt"
        safe.write_text("NEEDLE=safe\n")
        git("add", ".env.example", "safe.txt", cwd=self.repo)
        git("commit", "-m", "search fixtures", cwd=self.repo)
        result = WorkspaceToolExecutor(self.bindings).execute(self.action("repo.read", "autopilot:search:NEEDLE"))
        self.assertIn("safe.txt", result["matches"])
        self.assertNotIn(".env.example", result["matches"])

    def test_write_disabled_repo_cannot_prepare_or_test(self):
        self.bindings["p1"]["repo"]["autopilot"]["write_enabled"]=False
        ex=WorkspaceToolExecutor(self.bindings)
        with self.assertRaises(ReadActionError): ex.execute(self.action("repo.prepare","autopilot"))
        with self.assertRaises(ReadActionError): ex.execute(self.action("repo.test","autopilot:unit"))


class RepoBindingTest(unittest.TestCase):
    def test_repo_binding_rejects_workspace_inside_canonical_repo(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/"tools.json"; root=Path(tmp)/"repo"; root.mkdir()
            nested=root/"workspaces"
            p.write_text('{"projects":{"p":{"repo":{"r":{"path":"'+str(root)+'","workspaceRoot":"'+str(nested)+'","writeEnabled":true,"tests":{"unit":["python3","-c","print(1)"]}}}}}}')
            with self.assertRaises(ValueError): load_tool_bindings(p,{})

    def test_repo_binding_rejects_shell_test_and_invalid_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/"tools.json"; root=Path(tmp)/"repo"; root.mkdir()
            p.write_text('{"projects":{"p":{"repo":{"r":{"path":"'+str(root)+'","workspaceRoot":"'+str(Path(tmp)/'w')+'","writeEnabled":true,"tests":{"bad":["bash","-c","echo x"]}}}}}}')
            with self.assertRaises(ValueError): load_tool_bindings(p,{})
