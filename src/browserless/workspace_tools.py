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


def _run(command, cwd=None, timeout=30, allow=(0,)):
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, shell=False,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ReadActionError("repo_command_failed") from None
    if result.returncode not in allow:
        raise ReadActionError("repo_command_failed")
    return result




def _run_input(command, text, cwd=None, timeout=30, allow=(0,)):
    try:
        result = subprocess.run(command, cwd=cwd, input=text, capture_output=True, text=True, shell=False,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ReadActionError("repo_command_failed") from None
    if result.returncode not in allow:
        raise ReadActionError("repo_command_failed")
    return result


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


class WorkspaceToolExecutor:
    def __init__(self, bindings, store=None, bwrap_path="/usr/bin/bwrap", sandbox_runner=None):
        self.bindings = bindings
        self.store = store
        self.bwrap_path = bwrap_path
        self.sandbox_runner = sandbox_runner or subprocess.run

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
        remote=_run(["git","-C",root,"ls-remote","origin",f"refs/heads/{base}"]).stdout.strip().split()
        if len(remote)<2 or not re.fullmatch(r"[0-9a-fA-F]{40,64}",remote[0]): raise ReadActionError("repo_remote_head_unavailable")
        base_sha=remote[0]
        _run(["git","-C",root,"fetch","--no-tags","origin",base_sha],timeout=120)
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
        try:
            _run_input(["git","-C",str(workspace),"apply","--check","--whitespace=error-all","-"],patch)
            _run_input(["git","-C",str(workspace),"apply","--whitespace=error-all","-"],patch)
        except ReadActionError:
            raise ReadActionError("repo_patch_apply_failed") from None
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
              "--dir","/tmp/home","--dir","/workspace","--bind",str(workspace),"/workspace","--chdir","/workspace",
              "--clearenv","--setenv","PATH","/usr/bin:/bin","--setenv","HOME","/tmp/home","--setenv","CI","1",
              "--setenv","NO_COLOR","1",*command]
        try:
            result=self.sandbox_runner(argv,capture_output=True,text=True,shell=False,timeout=binding["test_timeout"],check=False)
        except (OSError,subprocess.TimeoutExpired): raise ReadActionError("repo_test_failed") from None
        output=((result.stdout or "")+(result.stderr or ""))
        after_diff,after_sha=_current_diff(workspace)
        mutation=after_sha!=before_sha
        passed=result.returncode==0 and not mutation
        self.store.set_repo_workspace_test(project_id,alias,before_sha,passed)
        return {"ok":True,"kind":"repo","operation":"test","alias":alias,"test":test_alias,
                "passed":passed,"returncode":int(result.returncode),
                "output":output[:60000],"output_sha256":hashlib.sha256(output.encode()).hexdigest(),
                "diff_sha":before_sha,"workspace_mutated":mutation}
