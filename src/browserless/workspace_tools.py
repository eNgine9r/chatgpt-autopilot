import hashlib
import os
import re
import subprocess
from pathlib import Path

from .read_tools import ALIAS, ReadActionError

MAX_REPO_FILE_BYTES = 65536
MAX_TREE_FILES = 300
MAX_SEARCH_OUTPUT = 60000
MAX_PATCH_CHARS = 20000
MAX_PATCH_FILES = 8
SENSITIVE_FILE = re.compile(r"(^|/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx))$", re.I)


def _harden_git_command(command):
    command=list(command)
    if command and command[0]=="git":
        return ["git","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","commit.gpgSign=false",*command[1:]]
    return command


def _run(command, cwd=None, timeout=30, allow=(0,)):
    command=_harden_git_command(command)
    env=None
    if command and command[0]=="git":
        env={**os.environ,"GIT_TERMINAL_PROMPT":"0","GCM_INTERACTIVE":"Never","LC_ALL":"C"}
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, shell=False, env=env,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ReadActionError("repo_command_failed") from None
    if result.returncode not in allow:
        raise ReadActionError("repo_command_failed")
    return result




def _run_input(command, text, cwd=None, timeout=30, allow=(0,)):
    command=_harden_git_command(command)
    env=None
    if command and command[0]=="git":
        env={**os.environ,"GIT_TERMINAL_PROMPT":"0","GCM_INTERACTIVE":"Never","LC_ALL":"C"}
    try:
        result = subprocess.run(command, cwd=cwd, input=text, capture_output=True, text=True, shell=False, env=env,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ReadActionError("repo_command_failed") from None
    if result.returncode not in allow:
        raise ReadActionError("repo_command_failed")
    return result




def _patch_apply_detail(stderr):
    text = str(stderr or "").lower()
    if "corrupt patch" in text or "patch fragment without header" in text or "unrecognized input" in text:
        return "corrupt_patch"
    if "trailing whitespace" in text or "whitespace error" in text or "space before tab" in text:
        return "whitespace_error"
    if "patch failed" in text or "does not apply" in text:
        return "hunk_mismatch"
    return "apply_check_failed"


def _check_patch_apply(root, patch):
    command = _harden_git_command(["git", "-C", str(root), "apply", "--check", "--whitespace=error-all", "-"])
    env = {**os.environ, "GIT_TERMINAL_PROMPT":"0", "GCM_INTERACTIVE":"Never", "LC_ALL":"C"}
    try:
        result = subprocess.run(command, input=patch, capture_output=True, text=True, shell=False, env=env,
                                timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ReadActionError("repo_patch_apply_failed", "apply_check_failed") from None
    if result.returncode != 0:
        raise ReadActionError("repo_patch_apply_failed", _patch_apply_detail(result.stderr))

def _current_diff(root):
    result = _run(["git", "-C", str(root), "diff", "--no-ext-diff", "--no-color", "--binary", "--", "."])
    text = result.stdout
    return text, hashlib.sha256(text.encode()).hexdigest()


def _write_path_allowed(path, allowed):
    normalized = str(path).replace("\\", "/")
    for rule in allowed:
        if rule.endswith("/") and normalized.startswith(rule):
            return True
        if normalized == rule:
            return True
    return False


def _patch_paths(patch):
    if not patch or len(patch) > MAX_PATCH_CHARS or "\x00" in patch:
        raise ReadActionError("repo_patch_invalid")
    forbidden = ("GIT binary patch", "Binary files ", "new file mode ", "deleted file mode ",
                 "old mode ", "new mode ", "rename from ", "rename to ", "copy from ", "copy to ",
                 "similarity index ")
    paths=[]
    current=None
    old_seen=False
    new_seen=False
    for line in patch.splitlines():
        if line.startswith("diff ") and not line.startswith("diff --git "):
            raise ReadActionError("repo_patch_operation_not_allowed")
        if any(line.startswith(token) for token in forbidden):
            raise ReadActionError("repo_patch_operation_not_allowed")
        if line.startswith("diff --git "):
            if current is not None and not (old_seen and new_seen):
                raise ReadActionError("repo_patch_invalid")
            parts=line.split()
            if len(parts)!=4 or not parts[2].startswith("a/") or not parts[3].startswith("b/"):
                raise ReadActionError("repo_patch_invalid")
            left=parts[2][2:]; right=parts[3][2:]
            if left!=right or not re.fullmatch(r"[A-Za-z0-9_.\-/]+", left) or ".." in Path(left).parts:
                raise ReadActionError("repo_patch_operation_not_allowed")
            current=left; old_seen=False; new_seen=False; paths.append(left)
            if len(paths)>MAX_PATCH_FILES or len(set(paths))!=len(paths):
                raise ReadActionError("repo_patch_too_many_files")
        elif line.startswith("--- "):
            if current is None or line != f"--- a/{current}":
                raise ReadActionError("repo_patch_operation_not_allowed")
            old_seen=True
        elif line.startswith("+++ "):
            if current is None or line != f"+++ b/{current}":
                raise ReadActionError("repo_patch_operation_not_allowed")
            new_seen=True
    if not paths or current is None or not (old_seen and new_seen):
        raise ReadActionError("repo_patch_invalid")
    return paths

def _assert_safe_git_attributes(root, paths=None):
    files=list(paths or _run(["git","-C",str(root),"ls-files"]).stdout.splitlines())
    for start in range(0,len(files),100):
        chunk=files[start:start+100]
        if not chunk: continue
        out=_run(["git","-C",str(root),"check-attr","filter","working-tree-encoding","ident","--",*chunk]).stdout
        for line in out.splitlines():
            parts=line.rsplit(": ",2)
            if len(parts)!=3: continue
            _path,attr,value=parts
            if attr in {"filter","working-tree-encoding"} and value not in {"unspecified","unset"}:
                raise ReadActionError("repo_external_transform_not_allowed")
            if attr=="ident" and value not in {"unspecified","unset","false"}:
                raise ReadActionError("repo_external_transform_not_allowed")


def _tracked_file(root, relative):
    if not relative or len(relative) > 240 or "\x00" in relative:
        raise ReadActionError("invalid_repo_path")
    rel = Path(relative)
    if rel.is_absolute() or ".." in rel.parts or SENSITIVE_FILE.search(relative.replace("\\", "/")):
        raise ReadActionError("repo_file_not_allowed")
    _run(["git", "-C", root, "ls-files", "--error-unmatch", "--", relative])
    base = Path(root).resolve(); candidate = (base / rel).resolve()
    try: candidate.relative_to(base)
    except ValueError: raise ReadActionError("repo_path_escape") from None
    if not candidate.is_file() or candidate.stat().st_size > MAX_REPO_FILE_BYTES:
        raise ReadActionError("repo_file_not_allowed")
    return candidate


def _workspace_identity(project_id, job_id):
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(project_id)).strip("-") or "project"
    return f"autopilot/browserless/{slug}/job-{int(job_id)}", f"job-{int(job_id)}"


def _required_tests_remaining(active, binding):
    required = list(binding.get("required_tests") if "required_tests" in binding else sorted((binding.get("tests") or {}).keys()))
    diff_sha = str(active.get("diff_sha") or "")
    attestations = active.get("test_attestations") if isinstance(active.get("test_attestations"), dict) else {}
    if not required or not diff_sha:
        return required or ["__required_tests_unconfigured__"]
    remaining = []
    for alias in required:
        item = attestations.get(alias) if isinstance(attestations.get(alias), dict) else {}
        if item.get("diff_sha") != diff_sha or item.get("passed") is not True:
            remaining.append(alias)
    return remaining


class WorkspaceToolExecutor:
    def __init__(self, bindings, store=None, bwrap_path="/usr/bin/bwrap", sandbox_runner=None, gh_runner=None, source_url_resolver=None):
        self.bindings = bindings
        self.store = store
        self.bwrap_path = bwrap_path
        self.sandbox_runner = sandbox_runner or subprocess.run
        self.gh_runner = gh_runner or subprocess.run
        self.source_url_resolver = source_url_resolver or (lambda binding: f"https://github.com/{binding['publish_repository']}.git")

    def execute(self, action):
        project_id = str(action.get("project_id") or "")
        project = self.bindings.get(project_id)
        if not project:
            raise ReadActionError("project_tools_unconfigured")
        kind = str(action.get("type") or "")
        target = str(action.get("target") or "")
        if kind == "repo.read": return self._read(project, target)
        if kind == "repo.prepare": return self._prepare(project_id, project, action, target)
        if kind == "repo.patch": return self._patch(project_id, project, action, target)
        if kind == "repo.test": return self._test(project_id, project, action, target)
        if kind == "repo.commit": return self._commit(project_id, project, action, target)
        if kind == "repo.publish": return self._publish(project_id, project, action, target)
        raise ReadActionError("workspace_action_not_allowed")

    @staticmethod
    def _binding(project, alias):
        if not ALIAS.fullmatch(alias): raise ReadActionError("invalid_repo_alias")
        binding = project.get("repo", {}).get(alias)
        if not binding: raise ReadActionError("repo_alias_not_allowed")
        return binding

    def _read(self, project, target):
        parts = target.split(":", 2)
        if len(parts) < 2: raise ReadActionError("invalid_repo_read_target")
        alias, mode = parts[0], parts[1]
        binding = self._binding(project, alias); root = binding["path"]
        if mode == "file":
            if len(parts) != 3: raise ReadActionError("invalid_repo_read_target")
            file = _tracked_file(root, parts[2]); raw = file.read_bytes()
            try: text = raw.decode("utf-8")
            except UnicodeDecodeError: raise ReadActionError("repo_file_not_text") from None
            return {"ok":True,"kind":"repo","operation":"file","alias":alias,"file":parts[2],
                    "sha256":hashlib.sha256(raw).hexdigest(),"content":text[:60000]}
        if mode == "tree":
            prefix = parts[2] if len(parts) == 3 else ""
            if prefix and (Path(prefix).is_absolute() or ".." in Path(prefix).parts or len(prefix) > 200):
                raise ReadActionError("invalid_repo_tree_prefix")
            args=["git","-C",root,"ls-files"] + (["--",prefix] if prefix else [])
            result=_run(args); files=[]
            for line in result.stdout.splitlines():
                if line and not SENSITIVE_FILE.search(line): files.append(line[:300])
                if len(files) >= MAX_TREE_FILES: break
            return {"ok":True,"kind":"repo","operation":"tree","alias":alias,"prefix":prefix,"files":files}
        if mode == "search":
            if len(parts) != 3: raise ReadActionError("invalid_repo_read_target")
            query=parts[2]
            if not query or len(query) > 120 or "\n" in query or "\x00" in query:
                raise ReadActionError("invalid_repo_search")
            result=_run(["git","-C",root,"grep","-n","-I","-F","-e",query,"--"], allow=(0,1))
            safe_lines=[]
            for line in result.stdout.splitlines():
                path_part=line.split(":",1)[0]
                if SENSITIVE_FILE.search(path_part.replace("\\","/")):
                    continue
                safe_lines.append(line[:2000])
            safe_text="\n".join(safe_lines)[:MAX_SEARCH_OUTPUT]
            return {"ok":True,"kind":"repo","operation":"search","alias":alias,"query":query,
                    "sha256":hashlib.sha256(safe_text.encode()).hexdigest(),"matches":safe_text}
        raise ReadActionError("invalid_repo_read_operation")

    def _prepare(self, project_id, project, action, target):
        if ":" in target: raise ReadActionError("invalid_repo_prepare_target")
        binding=self._binding(project,target)
        if not binding.get("write_enabled"): raise ReadActionError("repo_write_disabled")
        if self.store is None: raise ReadActionError("repo_workspace_store_unavailable")
        root=binding["path"]; base=binding["base_branch"]
        source_url=self.source_url_resolver(binding)
        workspace_root=Path(binding["workspace_root"]); workspace_root.mkdir(parents=True,exist_ok=True); workspace_root.chmod(0o700)
        active=self.store.active_repo_workspace(project_id,target)
        if active:
            workspace=Path(active["workspace_path"])
            try: workspace.resolve().relative_to(workspace_root.resolve())
            except ValueError: raise ReadActionError("repo_workspace_path_mismatch") from None
            if not workspace.is_dir(): raise ReadActionError("repo_workspace_missing")
            top=_run(["git","-C",str(workspace),"rev-parse","--show-toplevel"]).stdout.strip()
            current=_run(["git","-C",str(workspace),"branch","--show-current"]).stdout.strip()
            if Path(top).resolve()!=workspace.resolve() or current!=active["branch"]:
                raise ReadActionError("repo_workspace_identity_mismatch")
            return {"ok":True,"kind":"repo","operation":"prepare","alias":target,"workspace":str(workspace),
                    "branch":active["branch"],"base_sha":active["base_sha"],"reused":True,
                    "workspace_id":active["id"]}
        branch, dirname=_workspace_identity(project_id, action["job_id"])
        workspace=workspace_root/dirname
        if workspace.exists(): raise ReadActionError("repo_workspace_untracked_collision")
        _assert_safe_git_attributes(root)
        remote=_run(["git","-C",root,"ls-remote",source_url,f"refs/heads/{base}"]).stdout.strip().split()
        if len(remote)<2 or not re.fullmatch(r"[0-9a-fA-F]{40,64}",remote[0]): raise ReadActionError("repo_remote_head_unavailable")
        base_sha=remote[0]
        _run(["git","-C",root,"fetch","--no-tags",source_url,base_sha],timeout=120)
        exists=_run(["git","-C",root,"show-ref","--verify","--quiet",f"refs/heads/{branch}"],allow=(0,1)).returncode==0
        if exists: raise ReadActionError("repo_branch_already_exists")
        _run(["git","-C",root,"worktree","add","-b",branch,str(workspace),base_sha],timeout=60)
        try:
            active=self.store.register_repo_workspace(project_id,target,branch,str(workspace),base_sha)
        except Exception:
            _run(["git","-C",root,"worktree","remove","--force",str(workspace)],timeout=60,allow=(0,128))
            _run(["git","-C",root,"branch","-D",branch],timeout=30,allow=(0,1,128))
            raise ReadActionError("repo_workspace_state_failed") from None
        return {"ok":True,"kind":"repo","operation":"prepare","alias":target,"workspace":str(workspace),
                "branch":branch,"base_sha":base_sha,"reused":False,"workspace_id":active["id"]}

    def _patch(self, project_id, project, action, target):
        if ":" in target: raise ReadActionError("invalid_repo_patch_target")
        alias=target; binding=self._binding(project,alias)
        if not binding.get("write_enabled"): raise ReadActionError("repo_write_disabled")
        if self.store is None: raise ReadActionError("repo_workspace_store_unavailable")
        active=self.store.active_repo_workspace(project_id,alias)
        if not active: raise ReadActionError("repo_workspace_missing")
        if active.get("commit_sha"): raise ReadActionError("repo_workspace_already_committed")
        workspace=Path(active["workspace_path"]); workspace_root=Path(binding["workspace_root"])
        try: workspace.resolve().relative_to(workspace_root.resolve())
        except ValueError: raise ReadActionError("repo_workspace_path_mismatch") from None
        if not workspace.is_dir(): raise ReadActionError("repo_workspace_missing")
        current=_run(["git","-C",str(workspace),"branch","--show-current"]).stdout.strip()
        if current!=active["branch"]: raise ReadActionError("repo_workspace_identity_mismatch")
        patch=str(action.get("payload") or "")
        paths=_patch_paths(patch)
        for path in paths:
            if not _write_path_allowed(path,binding.get("write_paths",[])) or SENSITIVE_FILE.search(path):
                raise ReadActionError("repo_patch_path_not_allowed")
            _tracked_file(str(workspace),path)
            mode=_run(["git","-C",str(workspace),"ls-files","-s","--",path]).stdout.split()[:1]
            if not mode or mode[0]!="100644": raise ReadActionError("repo_patch_file_mode_not_allowed")
        status=_run(["git","-C",str(workspace),"status","--porcelain","--untracked-files=all"]).stdout
        if any(line.startswith("?? ") for line in status.splitlines()):
            raise ReadActionError("repo_workspace_untracked_files")
        before_diff,before_sha=_current_diff(workspace)
        if active.get("diff_sha"):
            if before_sha!=active["diff_sha"]: raise ReadActionError("repo_workspace_diff_mismatch")
        elif before_diff:
            raise ReadActionError("repo_workspace_diff_untracked")
        _check_patch_apply(workspace, patch)
        try:
            _run_input(["git","-C",str(workspace),"apply","--whitespace=error-all","-"],patch)
        except ReadActionError:
            raise ReadActionError("repo_patch_apply_failed", "apply_after_check_failed") from None
        try:
            diff,diff_sha=_current_diff(workspace)
            if not diff or len(diff)>MAX_SEARCH_OUTPUT:
                raise ReadActionError("repo_patch_result_invalid")
            changed=_run(["git","-C",str(workspace),"diff","--name-only","--", "."]).stdout.splitlines()
            if not changed or len(changed)>MAX_PATCH_FILES:
                raise ReadActionError("repo_patch_changed_files_invalid")
            for path in changed:
                if not _write_path_allowed(path,binding.get("write_paths",[])) or SENSITIVE_FILE.search(path):
                    raise ReadActionError("repo_patch_changed_files_mismatch")
                _tracked_file(str(workspace),path)
            self.store.set_repo_workspace_diff(project_id,alias,diff_sha)
        except Exception as exc:
            try:
                _run_input(["git","-C",str(workspace),"apply","--check","-R","-"],patch)
                _run_input(["git","-C",str(workspace),"apply","-R","-"],patch)
            except ReadActionError:
                raise ReadActionError("repo_patch_rollback_failed") from exc
            if isinstance(exc, ReadActionError):
                raise
            raise ReadActionError("repo_patch_state_failed") from None
        return {"ok":True,"kind":"repo","operation":"patch","alias":alias,"files":paths,
                "changed_files":changed,"diff_sha":diff_sha,"diff_chars":len(diff)}

    @staticmethod
    def _commit_subject(purpose):
        subject=" ".join(str(purpose or "").split())
        if not subject or len(subject)>100 or any(ord(ch)<32 for ch in subject):
            raise ReadActionError("repo_commit_message_invalid")
        return f"Autopilot: {subject}"[:120]

    def _commit(self, project_id, project, action, target):
        if ":" in target: raise ReadActionError("invalid_repo_commit_target")
        alias=target; binding=self._binding(project,alias)
        if not binding.get("write_enabled"): raise ReadActionError("repo_write_disabled")
        if self.store is None: raise ReadActionError("repo_workspace_store_unavailable")
        active=self.store.active_repo_workspace(project_id,alias)
        if not active: raise ReadActionError("repo_workspace_missing")
        workspace=Path(active["workspace_path"])
        try: workspace.resolve().relative_to(Path(binding["workspace_root"]).resolve())
        except ValueError: raise ReadActionError("repo_workspace_path_mismatch") from None
        remaining_tests=_required_tests_remaining(active,binding)
        if remaining_tests:
            raise ReadActionError("repo_commit_required_tests_missing")
        if active.get("commit_sha"):
            head=_run(["git","-C",str(workspace),"rev-parse","HEAD"]).stdout.strip()
            if head!=active["commit_sha"]: raise ReadActionError("repo_workspace_commit_mismatch")
            return {"ok":True,"kind":"repo","operation":"commit","alias":alias,"commit_sha":head,
                    "diff_sha":active["diff_sha"],"reused":True}
        current=_run(["git","-C",str(workspace),"branch","--show-current"]).stdout.strip()
        if current!=active["branch"]: raise ReadActionError("repo_workspace_identity_mismatch")
        diff,diff_sha=_current_diff(workspace)
        if not diff or diff_sha!=active["diff_sha"]: raise ReadActionError("repo_workspace_diff_mismatch")
        status=_run(["git","-C",str(workspace),"status","--porcelain","--untracked-files=all"]).stdout
        if any(line.startswith("?? ") for line in status.splitlines()): raise ReadActionError("repo_workspace_untracked_files")
        cached=_run(["git","-C",str(workspace),"diff","--cached","--name-only"]).stdout
        if cached.strip(): raise ReadActionError("repo_workspace_index_dirty")
        changed=_run(["git","-C",str(workspace),"diff","--name-only","--", "."]).stdout.splitlines()
        if not changed: raise ReadActionError("repo_commit_no_changes")
        for path in changed:
            if not _write_path_allowed(path,binding.get("write_paths",[])) or SENSITIVE_FILE.search(path):
                raise ReadActionError("repo_commit_path_not_allowed")
        _assert_safe_git_attributes(workspace,changed)
        _run(["git","-C",str(workspace),"add","--",*changed])
        try:
            staged=_run(["git","-C",str(workspace),"diff","--cached","--no-ext-diff","--no-color","--binary","--", "."]).stdout
            staged_sha=hashlib.sha256(staged.encode()).hexdigest()
            if staged_sha!=active["diff_sha"]: raise ReadActionError("repo_commit_staged_diff_mismatch")
            subject=self._commit_subject(action.get("purpose"))
            _run(["git","-C",str(workspace),"-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",
                  "-c","user.name=Browserless Autopilot","-c","user.email=browserless-autopilot@localhost",
                  "commit","--no-verify","-m",subject],timeout=60)
        except Exception as exc:
            _run(["git","-C",str(workspace),"reset","--mixed","HEAD"],allow=(0,1,128))
            if isinstance(exc,ReadActionError): raise
            raise ReadActionError("repo_commit_failed") from None
        commit_sha=_run(["git","-C",str(workspace),"rev-parse","HEAD"]).stdout.strip()
        parent=_run(["git","-C",str(workspace),"rev-parse","HEAD^"]).stdout.strip()
        if parent!=active["base_sha"]:
            _run(["git","-C",str(workspace),"reset","--mixed",active["base_sha"]])
            raise ReadActionError("repo_commit_parent_mismatch")
        if _run(["git","-C",str(workspace),"status","--porcelain","--untracked-files=all"]).stdout.strip():
            _run(["git","-C",str(workspace),"reset","--mixed",active["base_sha"]])
            raise ReadActionError("repo_commit_workspace_not_clean")
        try:
            self.store.set_repo_workspace_commit(project_id,alias,active["diff_sha"],commit_sha)
        except Exception:
            _run(["git","-C",str(workspace),"reset","--mixed",active["base_sha"]])
            restored,restored_sha=_current_diff(workspace)
            if not restored or restored_sha!=active["diff_sha"]: raise ReadActionError("repo_commit_rollback_failed") from None
            raise ReadActionError("repo_commit_state_failed") from None
        return {"ok":True,"kind":"repo","operation":"commit","alias":alias,"commit_sha":commit_sha,
                "diff_sha":active["diff_sha"],"files":changed,"reused":False}

    def _gh(self,args,input_text=None,timeout=30):
        try:
            env={**os.environ,"GH_HOST":"github.com","GH_PROMPT_DISABLED":"1","GH_PAGER":"cat","NO_COLOR":"1"}
            result=self.gh_runner(["gh",*args],input=input_text,capture_output=True,text=True,shell=False,env=env,timeout=timeout,check=False)
        except (OSError,subprocess.TimeoutExpired): raise ReadActionError("repo_publish_gh_failed") from None
        if result.returncode!=0: raise ReadActionError("repo_publish_gh_failed")
        return result.stdout

    def _existing_prs(self,repository,branch):
        raw=self._gh(["pr","list","--repo",repository,"--head",branch,"--state","open","--json","number,url,headRefName,baseRefName"])
        try: rows=__import__("json").loads(raw or "[]")
        except Exception: raise ReadActionError("repo_publish_gh_invalid_json") from None
        if not isinstance(rows,list) or len(rows)>1: raise ReadActionError("repo_publish_pr_ambiguous")
        return rows

    def _publish(self, project_id, project, action, target):
        if ":" in target: raise ReadActionError("invalid_repo_publish_target")
        alias=target; binding=self._binding(project,alias)
        if not binding.get("write_enabled"): raise ReadActionError("repo_write_disabled")
        if self.store is None: raise ReadActionError("repo_workspace_store_unavailable")
        active=self.store.active_repo_workspace(project_id,alias)
        if not active or not active.get("commit_sha"): raise ReadActionError("repo_publish_commit_required")
        if _required_tests_remaining(active,binding):
            raise ReadActionError("repo_publish_required_tests_missing")
        workspace=Path(active["workspace_path"])
        current=_run(["git","-C",str(workspace),"branch","--show-current"]).stdout.strip()
        head=_run(["git","-C",str(workspace),"rev-parse","HEAD"]).stdout.strip()
        if current!=active["branch"] or head!=active["commit_sha"]: raise ReadActionError("repo_workspace_commit_mismatch")
        if _run(["git","-C",str(workspace),"status","--porcelain","--untracked-files=all"]).stdout.strip():
            raise ReadActionError("repo_publish_workspace_not_clean")
        repository=binding.get("publish_repository") or ""
        source_url=self.source_url_resolver(binding)
        remote=_run(["git","-C",str(workspace),"ls-remote",source_url,f"refs/heads/{active['branch']}"]).stdout.strip().split()
        if remote:
            if remote[0]!=active["commit_sha"]: raise ReadActionError("repo_publish_remote_branch_collision")
            pushed=False
        else:
            _run(["git","-C",str(workspace),"-c","core.hooksPath=/dev/null","push","--porcelain",source_url,
                  f"HEAD:refs/heads/{active['branch']}"],timeout=120)
            verify=_run(["git","-C",str(workspace),"ls-remote",source_url,f"refs/heads/{active['branch']}"]).stdout.strip().split()
            if not verify or verify[0]!=active["commit_sha"]: raise ReadActionError("repo_publish_push_unverified")
            pushed=True
        rows=self._existing_prs(repository,active["branch"])
        if rows:
            row=rows[0]
            if row.get("headRefName")!=active["branch"] or row.get("baseRefName")!=binding["base_branch"]:
                raise ReadActionError("repo_publish_pr_mismatch")
            pr_number=int(row.get("number") or 0); pr_url=str(row.get("url") or ""); created=False
        else:
            title=" ".join(str(action.get("purpose") or "").split())[:100]
            if not title: raise ReadActionError("repo_publish_title_invalid")
            body=(f"Browserless Autopilot isolated workspace PR.\n\n"
                  f"Base SHA: `{active['base_sha']}`\nCommit SHA: `{active['commit_sha']}`\n"
                  f"Attested diff SHA: `{active['diff_sha']}`\nTests attested: yes\n\n"
                  "No autonomous merge or deploy is requested by this action.\n")
            self._gh(["pr","create","--repo",repository,"--base",binding["base_branch"],"--head",active["branch"],
                      "--title",title,"--body-file","-"],input_text=body,timeout=60)
            rows=self._existing_prs(repository,active["branch"])
            if len(rows)!=1: raise ReadActionError("repo_publish_pr_unconfirmed")
            row=rows[0]; pr_number=int(row.get("number") or 0); pr_url=str(row.get("url") or ""); created=True
        expected_pr_url=f"https://github.com/{repository}/pull/{pr_number}"
        if pr_number<=0 or pr_url.rstrip("/")!=expected_pr_url: raise ReadActionError("repo_publish_pr_invalid")
        try: self.store.set_repo_workspace_pr(project_id,alias,active["commit_sha"],pr_number,pr_url)
        except Exception: raise ReadActionError("repo_publish_state_failed") from None
        return {"ok":True,"kind":"repo","operation":"publish","alias":alias,"commit_sha":active["commit_sha"],
                "branch":active["branch"],"pr_number":pr_number,"pr_url":pr_url,"pushed":pushed,"created":created}

    def _test(self, project_id, project, action, target):
        parts=target.split(":",1)
        if len(parts)!=2: raise ReadActionError("invalid_repo_test_target")
        alias,test_alias=parts; binding=self._binding(project,alias)
        if not binding.get("write_enabled"): raise ReadActionError("repo_write_disabled")
        command=binding.get("tests",{}).get(test_alias)
        if not command: raise ReadActionError("repo_test_alias_not_allowed")
        if self.store is None: raise ReadActionError("repo_workspace_store_unavailable")
        active=self.store.active_repo_workspace(project_id,alias)
        if not active: raise ReadActionError("repo_workspace_missing")
        workspace=Path(active["workspace_path"])
        workspace_root=Path(binding["workspace_root"])
        try: workspace.resolve().relative_to(workspace_root.resolve())
        except ValueError: raise ReadActionError("repo_workspace_path_mismatch") from None
        if not workspace.is_dir(): raise ReadActionError("repo_workspace_missing")
        current=_run(["git","-C",str(workspace),"branch","--show-current"]).stdout.strip()
        if current!=active["branch"]: raise ReadActionError("repo_workspace_identity_mismatch")
        before_diff,before_sha=_current_diff(workspace)
        if active.get("diff_sha") and before_sha!=active["diff_sha"]:
            raise ReadActionError("repo_workspace_diff_mismatch")
        if self.sandbox_runner is subprocess.run and not Path(self.bwrap_path).is_file():
            raise ReadActionError("repo_test_sandbox_unavailable")
        argv=[self.bwrap_path,"--die-with-parent","--unshare-all",
              "--ro-bind","/usr","/usr","--ro-bind","/bin","/bin","--ro-bind","/lib","/lib",
              "--ro-bind","/etc","/etc","--proc","/proc","--dev","/dev","--tmpfs","/tmp","--tmpfs","/home",
              "--dir","/tmp/home","--dir","/workspace","--ro-bind",str(workspace),"/workspace","--chdir","/workspace",
              "--clearenv","--setenv","PATH","/usr/bin:/bin","--setenv","HOME","/tmp/home","--setenv","TMPDIR","/tmp",
              "--setenv","PYTHONDONTWRITEBYTECODE","1","--setenv","CI","1","--setenv","NO_COLOR","1",*command]
        try:
            result=self.sandbox_runner(argv,capture_output=True,text=True,shell=False,timeout=binding["test_timeout"],check=False)
        except (OSError,subprocess.TimeoutExpired): raise ReadActionError("repo_test_failed") from None
        output=((result.stdout or "")+(result.stderr or ""))
        after_diff,after_sha=_current_diff(workspace)
        mutation=after_sha!=before_sha
        passed=result.returncode==0 and not mutation
        self.store.set_repo_workspace_test(project_id,alias,test_alias,before_sha,passed)
        refreshed=self.store.active_repo_workspace(project_id,alias) or active
        remaining=_required_tests_remaining(refreshed,binding)
        return {"ok":True,"kind":"repo","operation":"test","alias":alias,"test":test_alias,
                "passed":passed,"returncode":int(result.returncode),
                "output":output[:60000],"output_sha256":hashlib.sha256(output.encode()).hexdigest(),
                "diff_sha":before_sha,"workspace_mutated":mutation,
                "required_tests_complete":not bool(remaining),
                "required_tests_remaining":[x for x in remaining if x != "__required_tests_unconfigured__"]}
