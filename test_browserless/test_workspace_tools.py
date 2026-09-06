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
            "publish_repository":"eNgine9r/chatgpt-autopilot","write_paths":["app.py","safe.txt"],"tests":{"unit":["python3","-c","print('ok')"]},"test_timeout":30}}}}

    def tearDown(self):
        self.store.close(); self.tmp.cleanup()

    def action(self, kind, target, job_id=7):
        return {"id":1,"job_id":job_id,"project_id":"p1","type":kind,"target":target,"purpose":"test"}

    def executor(self, **kwargs):
        return WorkspaceToolExecutor(self.bindings, source_url_resolver=lambda _binding: str(self.remote), **kwargs)

    @staticmethod
    def app_patch(old="print('hello')", new="print('changed')"):
        return f"diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1,2 +1,2 @@\n-{old}\n+{new}\n needle = 1\n"

    def ready_workspace(self, base_job=60):
        ex=self.executor(store=self.store)
        ex.execute(self.action("repo.prepare","autopilot",job_id=base_job))
        patched=ex.execute({**self.action("repo.patch","autopilot",job_id=base_job+1),"payload":self.app_patch()})
        tester=self.executor(store=self.store,bwrap_path="/usr/bin/bwrap",sandbox_runner=lambda *_args,**_kwargs: FakeResult())
        tested=tester.execute(self.action("repo.test","autopilot:unit",job_id=base_job+2))
        self.assertTrue(tested["passed"]); self.assertEqual(tested["diff_sha"],patched["diff_sha"])
        return ex,patched

    def test_repo_read_uses_only_tracked_files_and_literal_search(self):
        (self.repo/".env.local").write_text("DUMMY_PLACEHOLDER=not-a-secret\n")
        (self.repo/"untracked.py").write_text("private\n")
        ex=self.executor(store=self.store)
        file=ex.execute(self.action("repo.read","autopilot:file:app.py"))
        self.assertIn("needle",file["content"]); self.assertEqual(len(file["sha256"]),64)
        tree=ex.execute(self.action("repo.read","autopilot:tree"))
        self.assertIn("app.py",tree["files"]); self.assertNotIn(".env.local",tree["files"]); self.assertNotIn("untracked.py",tree["files"])
        search=ex.execute(self.action("repo.read","autopilot:search:needle"))
        self.assertIn("app.py",search["matches"])
        with self.assertRaises(ReadActionError): ex.execute(self.action("repo.read","autopilot:file:.env.local"))
        with self.assertRaises(ReadActionError): ex.execute(self.action("repo.read","autopilot:file:untracked.py"))

    def test_large_tracked_file_requires_bounded_lines_mode(self):
        large=self.repo/"large.py"
        large.write_text("".join(f"line_{i:04d} = '{'x'*260}'\n" for i in range(1,401)))
        git("add","large.py",cwd=self.repo); git("commit","-m","large fixture",cwd=self.repo); git("push","origin","main",cwd=self.repo)
        ex=self.executor(store=self.store)
        with self.assertRaises(ReadActionError) as ctx:
            ex.execute(self.action("repo.read","autopilot:file:large.py"))
        self.assertEqual(ctx.exception.code,"repo_file_too_large")
        result=ex.execute(self.action("repo.read","autopilot:lines:120:40:large.py"))
        self.assertEqual(result["operation"],"lines"); self.assertEqual(result["start_line"],120); self.assertEqual(result["end_line"],159)
        self.assertEqual(result["total_lines"],400); self.assertIn("line_0120",result["content"]); self.assertIn("line_0159",result["content"]); self.assertNotIn("line_0119",result["content"]); self.assertNotIn("line_0160",result["content"]); self.assertEqual(len(result["sha256"]),64)

    def test_lines_mode_rejects_invalid_range_sensitive_untracked_and_huge_source(self):
        ex=self.executor(store=self.store)
        for target in ("autopilot:lines:0:10:app.py","autopilot:lines:1:201:app.py","autopilot:lines:x:10:app.py",
                       "autopilot:lines:1:10:.env.local","autopilot:lines:1:10:missing.py"):
            with self.assertRaises(ReadActionError, msg=target): ex.execute(self.action("repo.read",target))
        huge=self.repo/"huge.py"; huge.write_text("x"*(1048576+1)); git("add","huge.py",cwd=self.repo); git("commit","-m","huge fixture",cwd=self.repo)
        with self.assertRaises(ReadActionError) as ctx: ex.execute(self.action("repo.read","autopilot:lines:1:10:huge.py"))
        self.assertEqual(ctx.exception.code,"repo_ranged_file_too_large")

    def test_prepare_rejects_external_checkout_transform_attributes(self):
        (self.repo/".gitattributes").write_text("app.py filter=evil\n")
        git("add",".gitattributes",cwd=self.repo); git("commit","-m","attrs",cwd=self.repo); git("push","origin","main",cwd=self.repo)
        ex=self.executor(store=self.store)
        with self.assertRaises(ReadActionError) as ctx: ex.execute(self.action("repo.prepare","autopilot",job_id=11))
        self.assertEqual(ctx.exception.code,"repo_external_transform_not_allowed")
        self.assertIsNone(self.store.active_repo_workspace("p1","autopilot"))

    def test_prepare_uses_remote_main_and_deterministic_workspace(self):
        canonical_before=git("rev-parse","HEAD",cwd=self.repo)
        ex=self.executor(store=self.store)
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
        ex=self.executor(store=self.store); ex.execute(self.action("repo.prepare","autopilot",job_id=21))
        seen={}
        def sandbox(argv, **kwargs):
            seen["argv"]=argv; seen["kwargs"]=kwargs
            return FakeResult()
        ex=self.executor(store=self.store,bwrap_path="/usr/bin/bwrap",sandbox_runner=sandbox)
        result=ex.execute(self.action("repo.test","autopilot:unit",job_id=22))
        argv=seen["argv"]
        self.assertIn("--unshare-all",argv); self.assertIn("--clearenv",argv)
        self.assertIn("--tmpfs",argv); self.assertIn("/home",argv)
        self.assertIn("--ro-bind",argv); self.assertNotIn("--bind",argv)
        self.assertIn("PYTHONDONTWRITEBYTECODE",argv); self.assertIn("TMPDIR",argv)
        self.assertNotIn("OPENAI_API_KEY",argv)
        self.assertFalse(seen["kwargs"]["shell"]); self.assertTrue(result["passed"])

    def test_workspace_session_survives_store_reopen_and_new_job(self):
        ex=self.executor(store=self.store)
        prepared=ex.execute(self.action("repo.prepare","autopilot",job_id=31))
        self.store.close()
        self.store=BrowserlessStore(str(self.db_path))
        seen={}
        def sandbox(argv, **kwargs):
            seen["argv"]=argv
            return FakeResult()
        ex=self.executor(store=self.store,bwrap_path="/usr/bin/bwrap",sandbox_runner=sandbox)
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
        result = self.executor(store=self.store).execute(self.action("repo.read", "autopilot:search:NEEDLE"))
        self.assertIn("safe.txt", result["matches"])
        self.assertNotIn(".env.example", result["matches"])

    def test_patch_applies_only_allowed_tracked_file_and_records_diff(self):
        store_path=Path(self.tmp.name)/"patch.sqlite3"
        from src.browserless.store import BrowserlessStore
        store=BrowserlessStore(str(store_path)); store.register_project("p1","2026-09-04-v1","anchor",{})
        try:
            ex=self.executor(store=store)
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
            ex=self.executor(store=store); ex.execute(self.action("repo.prepare","autopilot",job_id=40))
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

    def test_patch_apply_failure_exposes_only_safe_classification(self):
        ex=self.executor(store=self.store); ex.execute(self.action("repo.prepare","autopilot",job_id=44))
        bad=self.app_patch(old="print('not-current')",new="print('changed')")
        with self.assertRaises(ReadActionError) as ctx:
            ex.execute({**self.action("repo.patch","autopilot",job_id=45),"payload":bad})
        self.assertEqual(ctx.exception.code,"repo_patch_apply_failed")
        self.assertEqual(ctx.exception.detail,"hunk_mismatch")
        self.assertNotIn(str(self.workspace_root),ctx.exception.detail)

    def test_patch_rolls_back_if_durable_state_update_fails(self):
        from src.browserless.store import BrowserlessStore
        store=BrowserlessStore(str(Path(self.tmp.name)/"rollback.sqlite3")); store.register_project("p1","2026-09-04-v1","anchor",{})
        try:
            ex=self.executor(store=store); ex.execute(self.action("repo.prepare","autopilot",job_id=45))
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
            ex=self.executor(store=store); ex.execute(self.action("repo.prepare","autopilot",job_id=50))
            patch_result=ex.execute({**self.action("repo.patch","autopilot",job_id=51),"payload":self.app_patch()})
            seen={}
            def sandbox(argv,**kwargs): seen["argv"]=argv; return FakeResult()
            tester=self.executor(store=store,bwrap_path="/usr/bin/bwrap",sandbox_runner=sandbox)
            result=tester.execute(self.action("repo.test","autopilot:unit",job_id=52))
            self.assertTrue(result["passed"]); self.assertEqual(result["diff_sha"],patch_result["diff_sha"])
            active=store.active_repo_workspace("p1","autopilot"); self.assertTrue(active["last_test_passed"]); self.assertEqual(active["last_test_sha"],patch_result["diff_sha"])
            def mutating(argv,**kwargs):
                workspace=Path(active["workspace_path"]); (workspace/"app.py").write_text("test mutation\n"); return FakeResult()
            result=self.executor(store=store,bwrap_path="/usr/bin/bwrap",sandbox_runner=mutating).execute(self.action("repo.test","autopilot:unit",job_id=53))
            self.assertFalse(result["passed"]); self.assertTrue(result["workspace_mutated"]); self.assertFalse(store.active_repo_workspace("p1","autopilot")["last_test_passed"])
        finally: store.close()

    def test_commit_requires_every_required_test_on_same_diff(self):
        binding=self.bindings["p1"]["repo"]["autopilot"]
        binding["tests"]={"unit":["python3","-c","print('unit')"],"lint":["python3","-c","print('lint')"]}
        binding["required_tests"]=["unit","lint"]
        ex=self.executor(store=self.store)
        ex.execute(self.action("repo.prepare","autopilot",job_id=61))
        patched=ex.execute({**self.action("repo.patch","autopilot",job_id=62),"payload":self.app_patch()})
        tester=self.executor(store=self.store,bwrap_path="/usr/bin/bwrap",sandbox_runner=lambda *_args,**_kwargs: FakeResult())
        first=tester.execute(self.action("repo.test","autopilot:unit",job_id=63))
        self.assertFalse(first["required_tests_complete"]); self.assertEqual(first["required_tests_remaining"],["lint"])
        with self.assertRaises(ReadActionError) as ctx:
            ex.execute(self.action("repo.commit","autopilot",job_id=64))
        self.assertEqual(ctx.exception.code,"repo_commit_required_tests_missing")
        failing=self.executor(store=self.store,bwrap_path="/usr/bin/bwrap",sandbox_runner=lambda *_args,**_kwargs: FakeResult(returncode=1))
        second=failing.execute(self.action("repo.test","autopilot:lint",job_id=65))
        self.assertFalse(second["passed"]); self.assertFalse(second["required_tests_complete"]); self.assertEqual(second["required_tests_remaining"],["lint"])
        with self.assertRaises(ReadActionError): ex.execute(self.action("repo.commit","autopilot",job_id=66))
        third=tester.execute(self.action("repo.test","autopilot:lint",job_id=67))
        self.assertTrue(third["required_tests_complete"]); self.assertEqual(third["required_tests_remaining"],[])
        active=self.store.active_repo_workspace("p1","autopilot")
        self.assertEqual(active["test_attestations"]["unit"],{"diff_sha":patched["diff_sha"],"passed":True})
        self.assertEqual(active["test_attestations"]["lint"],{"diff_sha":patched["diff_sha"],"passed":True})
        committed=ex.execute({**self.action("repo.commit","autopilot",job_id=68),"purpose":"multi test proof"})
        self.assertTrue(committed["commit_sha"])

    def test_new_patch_clears_all_required_test_attestations(self):
        binding=self.bindings["p1"]["repo"]["autopilot"]
        binding["tests"]={"unit":["python3","-c","print('unit')"],"lint":["python3","-c","print('lint')"]}
        binding["required_tests"]=["unit","lint"]
        ex=self.executor(store=self.store); ex.execute(self.action("repo.prepare","autopilot",job_id=110))
        ex.execute({**self.action("repo.patch","autopilot",job_id=111),"payload":self.app_patch()})
        tester=self.executor(store=self.store,bwrap_path="/usr/bin/bwrap",sandbox_runner=lambda *_args,**_kwargs: FakeResult())
        tester.execute(self.action("repo.test","autopilot:unit",job_id=112)); tester.execute(self.action("repo.test","autopilot:lint",job_id=113))
        self.assertEqual(set(self.store.active_repo_workspace("p1","autopilot")["test_attestations"]),{"unit","lint"})
        ex.execute({**self.action("repo.patch","autopilot",job_id=114),"payload":self.app_patch(old="print('changed')",new="print('changed again')")})
        active=self.store.active_repo_workspace("p1","autopilot")
        self.assertEqual(active["test_attestations"],{}); self.assertFalse(active["last_test_passed"]); self.assertEqual(active["last_test_sha"],"")

    def test_commit_requires_exact_test_attestation_and_disables_repo_hooks(self):
        ex=self.executor(store=self.store)
        ex.execute(self.action("repo.prepare","autopilot",job_id=70))
        ex.execute({**self.action("repo.patch","autopilot",job_id=71),"payload":self.app_patch()})
        with self.assertRaises(ReadActionError) as ctx:
            ex.execute(self.action("repo.commit","autopilot",job_id=72))
        self.assertEqual(ctx.exception.code,"repo_commit_required_tests_missing")
        tester=self.executor(store=self.store,bwrap_path="/usr/bin/bwrap",sandbox_runner=lambda *_args,**_kwargs: FakeResult())
        tester.execute(self.action("repo.test","autopilot:unit",job_id=73))
        sentinel=Path(self.tmp.name)/"hook-fired"
        hook=self.repo/".git/hooks/pre-commit"; hook.write_text(f"#!/bin/sh\ntouch '{sentinel}'\nexit 1\n"); hook.chmod(0o755)
        committed=ex.execute({**self.action("repo.commit","autopilot",job_id=74),"purpose":"safe isolated patch"})
        self.assertFalse(sentinel.exists())
        active=self.store.active_repo_workspace("p1","autopilot")
        self.assertEqual(active["commit_sha"],committed["commit_sha"]); self.assertTrue(active["last_test_passed"])
        workspace=Path(active["workspace_path"]); self.assertEqual(git("status","--porcelain",cwd=workspace),"")
        self.assertEqual(git("rev-parse","HEAD^",cwd=workspace),active["base_sha"])
        reused=ex.execute({**self.action("repo.commit","autopilot",job_id=75),"purpose":"safe isolated patch"})
        self.assertTrue(reused["reused"]); self.assertEqual(reused["commit_sha"],committed["commit_sha"])
        with self.assertRaises(ReadActionError): ex.execute({**self.action("repo.patch","autopilot",job_id=76),"payload":self.app_patch(new="print('again')")})

    def test_commit_rolls_back_to_attested_diff_if_store_update_fails(self):
        ex,patched=self.ready_workspace(80)
        active=self.store.active_repo_workspace("p1","autopilot"); workspace=Path(active["workspace_path"])
        def fail(*_args,**_kwargs): raise RuntimeError("db")
        self.store.set_repo_workspace_commit=fail
        with self.assertRaises(ReadActionError) as ctx:
            ex.execute({**self.action("repo.commit","autopilot",job_id=83),"purpose":"rollback proof"})
        self.assertEqual(ctx.exception.code,"repo_commit_state_failed")
        diff=git("diff","--no-ext-diff","--no-color","--binary","--", ".",cwd=workspace)
        import hashlib
        self.assertEqual(hashlib.sha256((diff+"\n" if diff else "").encode()).hexdigest(),patched["diff_sha"] if diff else "")
        self.assertEqual(git("rev-parse","HEAD",cwd=workspace),active["base_sha"])

    def test_publish_pushes_only_generated_branch_and_creates_idempotent_pr(self):
        ex,_patched=self.ready_workspace(90)
        committed=ex.execute({**self.action("repo.commit","autopilot",job_id=93),"purpose":"publish proof"})
        state={"created":False,"calls":[]}
        def gh_runner(argv,**kwargs):
            state["calls"].append((list(argv),kwargs.get("input")))
            if argv[1:3]==["pr","list"]:
                rows=[] if not state["created"] else [{"number":321,"url":"https://github.com/eNgine9r/chatgpt-autopilot/pull/321","headRefName":self.store.active_repo_workspace("p1","autopilot")["branch"],"baseRefName":"main"}]
                import json; return FakeResult(stdout=json.dumps(rows))
            if argv[1:3]==["pr","create"]:
                state["created"]=True; return FakeResult(stdout="https://github.com/eNgine9r/chatgpt-autopilot/pull/321\n")
            return FakeResult(returncode=1,stderr="unexpected")
        publisher=self.executor(store=self.store,gh_runner=gh_runner)
        first=publisher.execute({**self.action("repo.publish","autopilot",job_id=94),"purpose":"Browserless publish proof"})
        self.assertTrue(first["pushed"]); self.assertTrue(first["created"]); self.assertEqual(first["pr_number"],321)
        active=self.store.active_repo_workspace("p1","autopilot")
        remote_sha=git("--git-dir",str(self.remote),"rev-parse",f"refs/heads/{active['branch']}")
        self.assertEqual(remote_sha,committed["commit_sha"]); self.assertEqual(active["pr_number"],321)
        second=publisher.execute({**self.action("repo.publish","autopilot",job_id=95),"purpose":"Browserless publish proof"})
        self.assertFalse(second["pushed"]); self.assertFalse(second["created"]); self.assertEqual(second["pr_number"],321)
        create_calls=[c for c,_ in state["calls"] if c[1:3]==["pr","create"]]
        self.assertEqual(len(create_calls),1)
        self.assertTrue(any("No autonomous merge or deploy" in (body or "") for _cmd,body in state["calls"]))

    def test_publish_requires_commit(self):
        ex=self.executor(store=self.store); ex.execute(self.action("repo.prepare","autopilot",job_id=100))
        with self.assertRaises(ReadActionError) as ctx: ex.execute(self.action("repo.publish","autopilot",job_id=101))
        self.assertEqual(ctx.exception.code,"repo_publish_commit_required")

    def test_write_disabled_repo_cannot_prepare_or_test(self):
        self.bindings["p1"]["repo"]["autopilot"]["write_enabled"]=False
        ex=self.executor(store=self.store)
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

    def test_repo_binding_requires_exact_publish_repository(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/"repo"; root.mkdir(); workspace=Path(tmp)/"workspaces"; p=Path(tmp)/"tools.json"
            base={"path":str(root),"workspaceRoot":str(workspace),"writeEnabled":True,"writePaths":["src/"],"tests":{"unit":["python3","-c","print(1)"]}}
            for bad in ("", "https://github.com/o/r", "o/r/extra", "../r", "o/..", "o/."):
                doc={"projects":{"p":{"repo":{"r":{**base,"publishRepository":bad}}}}}; p.write_text(json.dumps(doc))
                with self.assertRaises(ValueError, msg=bad): load_tool_bindings(p,{})
            doc={"projects":{"p":{"repo":{"r":{**base,"publishRepository":"o/r"}}}}}; p.write_text(json.dumps(doc))
            loaded=load_tool_bindings(p,{})
            self.assertEqual(loaded["p"]["repo"]["r"]["publish_repository"],"o/r")

    def test_required_tests_default_to_all_and_explicit_subset_is_validated(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/"repo"; root.mkdir(); workspace=Path(tmp)/"workspaces"; p=Path(tmp)/"tools.json"
            base={"path":str(root),"workspaceRoot":str(workspace),"writeEnabled":True,"writePaths":["src/"],
                  "publishRepository":"o/r","tests":{"unit":["python3","-c","print(1)"],"lint":["python3","-c","print(2)"]}}
            p.write_text(json.dumps({"projects":{"p":{"repo":{"r":base}}}}))
            loaded=load_tool_bindings(p,{})
            self.assertEqual(loaded["p"]["repo"]["r"]["required_tests"],["lint","unit"])
            explicit={**base,"requiredTests":["unit"]}; p.write_text(json.dumps({"projects":{"p":{"repo":{"r":explicit}}}}))
            loaded=load_tool_bindings(p,{})
            self.assertEqual(loaded["p"]["repo"]["r"]["required_tests"],["unit"])
            for bad in (["missing"],["unit","unit"],"unit"):
                doc={**base,"requiredTests":bad}; p.write_text(json.dumps({"projects":{"p":{"repo":{"r":doc}}}}))
                with self.assertRaises(ValueError): load_tool_bindings(p,{})

    def test_write_enabled_repo_requires_nonempty_required_test_gate(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/"repo"; root.mkdir(); workspace=Path(tmp)/"workspaces"; p=Path(tmp)/"tools.json"
            base={"path":str(root),"workspaceRoot":str(workspace),"writeEnabled":True,"writePaths":["src/"],"publishRepository":"o/r"}
            p.write_text(json.dumps({"projects":{"p":{"repo":{"r":{**base,"tests":{}}}}}}))
            with self.assertRaises(ValueError): load_tool_bindings(p,{})
            p.write_text(json.dumps({"projects":{"p":{"repo":{"r":{**base,"tests":{"unit":["python3","-c","print(1)"]},"requiredTests":[]}}}}}))
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
