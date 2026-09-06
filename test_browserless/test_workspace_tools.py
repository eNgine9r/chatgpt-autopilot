import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from src.browserless.read_tools import ReadActionError, load_tool_bindings
from src.browserless.store import BrowserlessStore
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
        self.db_path=root/"core.sqlite3"
        self.store=BrowserlessStore(str(self.db_path)); self.store.register_project("p1","2026-09-04-v1","anchor",{})
        self.bindings={"p1":{"github":{},"runtime":{},"git":{},"evidence":{},"repo":{"autopilot":{
            "path":str(self.repo),"workspace_root":str(self.workspace_root),"base_branch":"main","write_enabled":True,
            "write_paths":["app.py","safe.txt"],"tests":{"unit":["python3","-c","print('ok')"]},"test_timeout":30}}}}

    def tearDown(self):
        self.store.close(); self.tmp.cleanup()

    def action(self, kind, target, job_id=7):
        return {"id":1,"job_id":job_id,"project_id":"p1","type":kind,"target":target,"purpose":"test"}

    @staticmethod
    def app_patch(old="print('hello')", new="print('changed')"):
        return f"diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1,2 +1,2 @@\n-{old}\n+{new}\n needle = 1\n"

    def test_repo_read_uses_only_tracked_files_and_literal_search(self):
        (self.repo/".env.local").write_text("DUMMY_PLACEHOLDER=not-a-secret\n")
        (self.repo/"untracked.py").write_text("private\n")
        ex=WorkspaceToolExecutor(self.bindings, store=self.store)
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
        ex=WorkspaceToolExecutor(self.bindings, store=self.store)
        result=ex.execute(self.action("repo.prepare","autopilot",job_id=12))
        remote_head=git("rev-parse","refs/heads/main",cwd=self.remote)
        self.assertEqual(result["base_sha"],remote_head)
        self.assertEqual(result["branch"],"autopilot/browserless/p1/job-12")
        self.assertEqual(git("rev-parse","HEAD",cwd=self.repo),canonical_before)
        self.assertTrue(Path(result["workspace"]).is_dir())
        self.assertEqual(self.store.active_repo_workspace("p1","autopilot")["branch"], result["branch"])
        reused=ex.execute(self.action("repo.prepare","autopilot",job_id=99))
        self.assertTrue(reused["reused"]); self.assertEqual(reused["branch"],result["branch"])

    def test_test_action_uses_bwrap_contract_and_no_secret_environment(self):
        ex=WorkspaceToolExecutor(self.bindings, store=self.store); ex.execute(self.action("repo.prepare","autopilot",job_id=21))
        seen={}
        def sandbox(argv, **kwargs):
            seen["argv"]=argv; seen["kwargs"]=kwargs
            return FakeResult()
        ex=WorkspaceToolExecutor(self.bindings,store=self.store,bwrap_path="/usr/bin/bwrap",sandbox_runner=sandbox)
        result=ex.execute(self.action("repo.test","autopilot:unit",job_id=22))
        argv=seen["argv"]
        self.assertIn("--unshare-all",argv); self.assertIn("--clearenv",argv)
        self.assertIn("--tmpfs",argv); self.assertIn("/home",argv)
        self.assertNotIn("OPENAI_API_KEY",argv)
        self.assertFalse(seen["kwargs"]["shell"]); self.assertTrue(result["passed"])

    def test_workspace_session_survives_store_reopen_and_new_job(self):
        ex=WorkspaceToolExecutor(self.bindings, store=self.store)
        prepared=ex.execute(self.action("repo.prepare","autopilot",job_id=31))
        self.store.close()
        self.store=BrowserlessStore(str(self.db_path))
        seen={}
        def sandbox(argv, **kwargs):
            seen["argv"]=argv
            return FakeResult()
        ex=WorkspaceToolExecutor(self.bindings,store=self.store,bwrap_path="/usr/bin/bwrap",sandbox_runner=sandbox)
        tested=ex.execute(self.action("repo.test","autopilot:unit",job_id=32))
        self.assertTrue(tested["passed"])
        active=self.store.active_repo_workspace("p1","autopilot")
        self.assertEqual(active["branch"],prepared["branch"])
        self.assertIn(str(Path(prepared["workspace"])), seen["argv"])

    def test_repo_search_filters_sensitive_tracked_filenames(self):
        sensitive = self.repo / ".env.example"
        sensitive.write_text("NEEDLE=secret\n")
        safe = self.repo / "safe.txt"
        safe.write_text("NEEDLE=safe\n")
        git("add", ".env.example", "safe.txt", cwd=self.repo)
        git("commit", "-m", "search fixtures", cwd=self.repo)
        result = WorkspaceToolExecutor(self.bindings, store=self.store).execute(self.action("repo.read", "autopilot:search:NEEDLE"))
        self.assertIn("safe.txt", result["matches"])
        self.assertNotIn(".env.example", result["matches"])

    def test_patch_applies_only_allowed_tracked_file_and_records_diff(self):
        store_path=Path(self.tmp.name)/"patch.sqlite3"
        from src.browserless.store import BrowserlessStore
        store=BrowserlessStore(str(store_path)); store.register_project("p1","2026-09-04-v1","anchor",{})
        try:
            ex=WorkspaceToolExecutor(self.bindings,store=store)
            ex.execute(self.action("repo.prepare","autopilot",job_id=30))
            patch=self.app_patch()
            result=ex.execute({**self.action("repo.patch","autopilot",job_id=31),"payload":patch})
            self.assertEqual(result["files"],["app.py"]); self.assertEqual(len(result["diff_sha"]),64)
            active=store.active_repo_workspace("p1","autopilot")
            self.assertEqual(active["diff_sha"],result["diff_sha"]); self.assertFalse(active["last_test_passed"])
            self.assertIn("changed",(Path(active["workspace_path"])/"app.py").read_text())
        finally: store.close()

    def test_patch_rejects_disallowed_new_delete_rename_mode_binary_and_out_of_band_diff(self):
        from src.browserless.store import BrowserlessStore
        store=BrowserlessStore(str(Path(self.tmp.name)/"reject.sqlite3")); store.register_project("p1","2026-09-04-v1","anchor",{})
        try:
            ex=WorkspaceToolExecutor(self.bindings,store=store); ex.execute(self.action("repo.prepare","autopilot",job_id=40))
            bad=[
              "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-tracked docs\n+x\n",
              "diff --git a/new.py b/new.py\nnew file mode 100644\n--- /dev/null\n+++ b/new.py\n@@ -0,0 +1 @@\n+x\n",
              "diff --git a/app.py b/app.py\ndeleted file mode 100644\n--- a/app.py\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-print('hello')\n-needle = 1\n",
              "diff --git a/app.py b/safe.txt\nrename from app.py\nrename to safe.txt\n",
              "diff --git a/app.py b/app.py\nold mode 100644\nnew mode 100755\n",
              "diff --git a/app.py b/app.py\nGIT binary patch\nliteral 0\nHcmV?d00001\n",
            ]
            for patch in bad:
                with self.assertRaises(ReadActionError): ex.execute({**self.action("repo.patch","autopilot",job_id=41),"payload":patch})
            active=store.active_repo_workspace("p1","autopilot"); (Path(active["workspace_path"])/"app.py").write_text("manual change\n")
            with self.assertRaises(ReadActionError) as ctx:
                ex.execute({**self.action("repo.patch","autopilot",job_id=42),"payload":self.app_patch()})
            self.assertEqual(ctx.exception.code,"repo_workspace_diff_untracked")
        finally: store.close()

    def test_patch_rolls_back_if_durable_state_update_fails(self):
        from src.browserless.store import BrowserlessStore
        store=BrowserlessStore(str(Path(self.tmp.name)/"rollback.sqlite3")); store.register_project("p1","2026-09-04-v1","anchor",{})
        try:
            ex=WorkspaceToolExecutor(self.bindings,store=store); ex.execute(self.action("repo.prepare","autopilot",job_id=45))
            active=store.active_repo_workspace("p1","autopilot"); workspace=Path(active["workspace_path"]); before=(workspace/"app.py").read_text()
            def fail_state(*_args,**_kwargs): raise RuntimeError("simulated db failure")
            store.set_repo_workspace_diff=fail_state
            with self.assertRaises(ReadActionError) as ctx:
                ex.execute({**self.action("repo.patch","autopilot",job_id=46),"payload":self.app_patch()})
            self.assertEqual(ctx.exception.code,"repo_patch_state_failed")
            self.assertEqual((workspace/"app.py").read_text(),before)
            self.assertEqual(git("diff","--", ".",cwd=workspace),"")
        finally: store.close()

    def test_test_attests_exact_patch_diff_and_detects_test_mutation(self):
        from src.browserless.store import BrowserlessStore
        store=BrowserlessStore(str(Path(self.tmp.name)/"attest.sqlite3")); store.register_project("p1","2026-09-04-v1","anchor",{})
        try:
            ex=WorkspaceToolExecutor(self.bindings,store=store); ex.execute(self.action("repo.prepare","autopilot",job_id=50))
            patch_result=ex.execute({**self.action("repo.patch","autopilot",job_id=51),"payload":self.app_patch()})
            seen={}
            def sandbox(argv,**kwargs): seen["argv"]=argv; return FakeResult()
            tester=WorkspaceToolExecutor(self.bindings,store=store,bwrap_path="/usr/bin/bwrap",sandbox_runner=sandbox)
            result=tester.execute(self.action("repo.test","autopilot:unit",job_id=52))
            self.assertTrue(result["passed"]); self.assertEqual(result["diff_sha"],patch_result["diff_sha"])
            active=store.active_repo_workspace("p1","autopilot"); self.assertTrue(active["last_test_passed"]); self.assertEqual(active["last_test_sha"],patch_result["diff_sha"])
            def mutating(argv,**kwargs):
                workspace=Path(active["workspace_path"]); (workspace/"app.py").write_text("test mutation\n"); return FakeResult()
            result=WorkspaceToolExecutor(self.bindings,store=store,bwrap_path="/usr/bin/bwrap",sandbox_runner=mutating).execute(self.action("repo.test","autopilot:unit",job_id=53))
            self.assertFalse(result["passed"]); self.assertTrue(result["workspace_mutated"]); self.assertFalse(store.active_repo_workspace("p1","autopilot")["last_test_passed"])
        finally: store.close()

    def test_write_disabled_repo_cannot_prepare_or_test(self):
        self.bindings["p1"]["repo"]["autopilot"]["write_enabled"]=False
        ex=WorkspaceToolExecutor(self.bindings, store=self.store)
        with self.assertRaises(ReadActionError): ex.execute(self.action("repo.prepare","autopilot"))
        with self.assertRaises(ReadActionError): ex.execute(self.action("repo.test","autopilot:unit"))


class RepoBindingTest(unittest.TestCase):
    def test_repo_binding_rejects_workspace_inside_canonical_repo(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/"tools.json"; root=Path(tmp)/"repo"; root.mkdir()
            nested=root/"workspaces"
            p.write_text('{"projects":{"p":{"repo":{"r":{"path":"'+str(root)+'","workspaceRoot":"'+str(nested)+'","writeEnabled":true,"tests":{"unit":["python3","-c","print(1)"]}}}}}}')
            with self.assertRaises(ValueError): load_tool_bindings(p,{})

    def test_repo_binding_rejects_workspace_parent_of_canonical_repo(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent=Path(tmp)/"parent"; parent.mkdir(); root=parent/"repo"; root.mkdir()
            p=Path(tmp)/"tools.json"
            p.write_text('{"projects":{"p":{"repo":{"r":{"path":"'+str(root)+'","workspaceRoot":"'+str(parent)+'","writeEnabled":true,"tests":{"unit":["python3","-c","print(1)"]}}}}}}')
            with self.assertRaises(ValueError): load_tool_bindings(p,{})

    def test_repo_binding_rejects_sensitive_write_paths(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/"repo"; root.mkdir(); workspace=Path(tmp)/"workspaces"
            for value in (".env", ".env.local", "credentials.json", "cert.pem", "id_ed25519"):
                p=Path(tmp)/"tools.json"
                p.write_text(json.dumps({"projects":{"p":{"repo":{"r":{"path":str(root),"workspaceRoot":str(workspace),"writeEnabled":True,"writePaths":[value],"tests":{}}}}}}))
                with self.assertRaises(ValueError, msg=value): load_tool_bindings(p,{})

    def test_repo_binding_rejects_shell_test_and_invalid_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/"tools.json"; root=Path(tmp)/"repo"; root.mkdir()
            p.write_text('{"projects":{"p":{"repo":{"r":{"path":"'+str(root)+'","workspaceRoot":"'+str(Path(tmp)/'w')+'","writeEnabled":true,"tests":{"bad":["bash","-c","echo x"]}}}}}}')
            with self.assertRaises(ValueError): load_tool_bindings(p,{})
