import hashlib
import json
import os
import re
import subprocess
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from .sources import runtime_observation

REPO = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/(?!(?:\.|\..)($))[A-Za-z0-9_.-]{1,100}$")
ALIAS = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
SENSITIVE_KEY = re.compile(r"(?:secret|password|passwd|token|api[_-]?key|authorization|cookie)", re.I)
SENSITIVE_REPO_PATH = re.compile(r"(^|/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx))$", re.I)
MAX_HTTP_BYTES = 131072
MAX_FILE_BYTES = 65536


class ReadActionError(RuntimeError):
    def __init__(self, code, detail=""):
        self.code = str(code)
        candidate = str(detail)[:80]
        self.detail = candidate if re.fullmatch(r"[a-z0-9_.-]{1,80}", candidate) else ""
        super().__init__(self.code)


def _loopback_url(value):
    try:
        u = urlparse(str(value))
    except Exception:
        return False
    return bool(u.scheme == "http" and u.hostname in {"127.0.0.1", "localhost", "::1"}
                and not u.username and not u.password and not u.query and not u.fragment)


def load_tool_bindings(path, env=None):
    env = os.environ if env is None else env
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    projects = {}
    for project_id, raw_project in (doc.get("projects") or {}).items():
        project = {"github": {}, "runtime": {}, "git": {}, "evidence": {}, "repo": {}}
        for alias, raw in ((raw_project or {}).get("github") or {}).items():
            repo = str((raw or {}).get("repository") or "")
            token_env = str((raw or {}).get("tokenEnv") or "")
            use_gh_auth = bool((raw or {}).get("useGhAuth", False))
            if not ALIAS.fullmatch(str(alias)) or not REPO.fullmatch(repo):
                raise ValueError(f"invalid github read binding: {project_id}/{alias}")
            if token_env and use_gh_auth:
                raise ValueError(f"github read auth modes are mutually exclusive: {project_id}/{alias}")
            token = str(env.get(token_env) or "") if token_env else ""
            if token_env and not token:
                raise ValueError(f"missing github read token env: {token_env}")
            project["github"][str(alias)] = {"repository": repo, "token": token, "use_gh_auth": use_gh_auth}
        for alias, raw in ((raw_project or {}).get("runtime") or {}).items():
            url = str((raw or {}).get("url") or "")
            if not ALIAS.fullmatch(str(alias)) or not _loopback_url(url):
                raise ValueError(f"invalid runtime read binding: {project_id}/{alias}")
            project["runtime"][str(alias)] = {"url": url}
        for alias, raw in ((raw_project or {}).get("git") or {}).items():
            root = Path(str((raw or {}).get("path") or ""))
            if not ALIAS.fullmatch(str(alias)) or not root.is_absolute():
                raise ValueError(f"invalid git read binding: {project_id}/{alias}")
            project["git"][str(alias)] = {"path": str(root)}
        for alias, raw in ((raw_project or {}).get("evidence") or {}).items():
            root = Path(str((raw or {}).get("root") or ""))
            if not ALIAS.fullmatch(str(alias)) or not root.is_absolute():
                raise ValueError(f"invalid evidence read binding: {project_id}/{alias}")
            project["evidence"][str(alias)] = {"root": str(root)}
        for alias, raw in ((raw_project or {}).get("repo") or {}).items():
            root = Path(str((raw or {}).get("path") or ""))
            workspace_root = Path(str((raw or {}).get("workspaceRoot") or ""))
            base_branch = str((raw or {}).get("baseBranch") or "main")
            write_enabled = bool((raw or {}).get("writeEnabled", False))
            publish_repository = str((raw or {}).get("publishRepository") or "")
            tests = (raw or {}).get("tests") or {}
            write_paths = (raw or {}).get("writePaths") or []
            if not ALIAS.fullmatch(str(alias)) or not root.is_absolute():
                raise ValueError(f"invalid repo binding: {project_id}/{alias}")
            if write_enabled and not workspace_root.is_absolute():
                raise ValueError(f"invalid repo workspace root: {project_id}/{alias}")
            if write_enabled and not REPO.fullmatch(publish_repository):
                raise ValueError(f"invalid repo publish repository: {project_id}/{alias}")
            root_resolved = root.resolve()
            workspace_resolved = workspace_root.resolve() if write_enabled else None
            if write_enabled:
                if (workspace_resolved == root_resolved or root_resolved in workspace_resolved.parents
                        or workspace_resolved in root_resolved.parents):
                    raise ValueError(f"repo workspace must be disjoint from canonical repo: {project_id}/{alias}")
            if not re.fullmatch(r"[A-Za-z0-9._/-]{1,100}", base_branch) or ".." in base_branch or base_branch.startswith("-"):
                raise ValueError(f"invalid repo base branch: {project_id}/{alias}")
            normalized_write_paths = []
            for item in write_paths:
                value = str(item).replace("\\", "/")
                rel = Path(value.rstrip("/"))
                if (not value or len(value) > 240 or value.startswith("/") or ".." in rel.parts
                        or value.startswith("./") or SENSITIVE_KEY.search(value) or SENSITIVE_REPO_PATH.search(value)):
                    raise ValueError(f"invalid repo write path: {project_id}/{alias}")
                if not re.fullmatch(r"[A-Za-z0-9_.\-/]+", value):
                    raise ValueError(f"invalid repo write path: {project_id}/{alias}")
                normalized_write_paths.append(value)
            if write_enabled and not normalized_write_paths:
                raise ValueError(f"repo write paths required: {project_id}/{alias}")
            normalized_tests = {}
            for test_alias, command in tests.items():
                if not ALIAS.fullmatch(str(test_alias)) or not isinstance(command, list) or not (1 <= len(command) <= 20):
                    raise ValueError(f"invalid repo test binding: {project_id}/{alias}/{test_alias}")
                argv = [str(item) for item in command]
                if any(not item or len(item) > 300 or "\x00" in item for item in argv):
                    raise ValueError(f"invalid repo test argv: {project_id}/{alias}/{test_alias}")
                executable = Path(argv[0]).name
                if executable not in {"npm", "node", "python3", "pytest", "pnpm", "yarn"}:
                    raise ValueError(f"repo test executable not allowed: {project_id}/{alias}/{test_alias}")
                normalized_tests[str(test_alias)] = argv
            raw_required_tests = (raw or {}).get("requiredTests")
            if raw_required_tests is None:
                required_tests = sorted(normalized_tests)
            else:
                if not isinstance(raw_required_tests, list) or len(raw_required_tests) > 16:
                    raise ValueError(f"invalid repo required tests: {project_id}/{alias}")
                required_tests = [str(item) for item in raw_required_tests]
                if (len(required_tests) != len(set(required_tests)) or any(not ALIAS.fullmatch(item) for item in required_tests)
                        or any(item not in normalized_tests for item in required_tests)):
                    raise ValueError(f"invalid repo required tests: {project_id}/{alias}")
            if write_enabled and (not normalized_tests or not required_tests):
                raise ValueError(f"repo required tests required: {project_id}/{alias}")
            timeout = int((raw or {}).get("testTimeoutSeconds") or 600)
            if timeout < 1 or timeout > 900:
                raise ValueError(f"invalid repo test timeout: {project_id}/{alias}")
            project["repo"][str(alias)] = {"path": str(root_resolved), "workspace_root": str(workspace_resolved) if write_enabled else "",
                                                "base_branch": base_branch, "write_enabled": write_enabled,
                                                "write_paths": normalized_write_paths, "publish_repository": publish_repository,
                                                "tests": normalized_tests, "required_tests": required_tests, "test_timeout": timeout}
        projects[str(project_id)] = project
    return projects


def capability_manifest(bindings):
    """Return a bounded, non-secret tool contract for Luna context."""
    syntax = {
        "github.read": "<github-alias>:issue|pr|commit|run:<identity>",
        "runtime.read": "<runtime-alias>",
        "git.read": "<git-alias>:head|branch|status|diffstat OR <git-alias>:log:<1-20>",
        "evidence.read": "<evidence-alias>:<relative .json/.md/.txt file>",
        "repo.read": "<repo-alias>:file:<tracked-path> OR <repo-alias>:tree[:prefix] OR <repo-alias>:search:<literal>",
        "repo.prepare": "<repo-alias>",
        "repo.patch": "<repo-alias>; payload must be raw git-style unified diff starting `diff --git a/<path> b/<path>`, with `--- a/<path>` and `+++ b/<path>`; no Markdown fences",
        "repo.test": "<repo-alias>:<test-alias>",
        "repo.commit": "<repo-alias>",
        "repo.publish": "<repo-alias>",
    }
    result = {}
    for project_id, project in sorted((bindings or {}).items()):
        repos = {}
        for alias, repo in sorted((project.get("repo") or {}).items())[:8]:
            write_enabled = bool(repo.get("write_enabled"))
            repos[str(alias)] = {
                "readModes": ["file", "tree", "search"],
                "writeEnabled": write_enabled,
                "writePaths": [str(x)[:240] for x in list(repo.get("write_paths") or [])[:16]] if write_enabled else [],
                "testAliases": sorted(str(x)[:80] for x in (repo.get("tests") or {}))[:16] if write_enabled else [],
                "requiredTestAliases": [str(x)[:80] for x in list(repo.get("required_tests") if "required_tests" in repo else sorted((repo.get("tests") or {}).keys()))[:16]] if write_enabled else [],
                "publishEnabled": bool(write_enabled and repo.get("publish_repository")),
            }
        result[str(project_id)] = {
            "syntax": syntax,
            "aliases": {
                "github": sorted(str(x)[:80] for x in (project.get("github") or {}))[:16],
                "runtime": sorted(str(x)[:80] for x in (project.get("runtime") or {}))[:16],
                "git": sorted(str(x)[:80] for x in (project.get("git") or {}))[:16],
                "evidence": sorted(str(x)[:80] for x in (project.get("evidence") or {}))[:16],
                "repo": sorted(str(x)[:80] for x in (project.get("repo") or {}))[:16],
            },
            "repo": repos,
        }
    return result


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _req, _fp, _code, _msg, _headers, _newurl):
        return None


def _default_json_get(url, headers, timeout=10):
    request = urllib.request.Request(url, headers=headers, method="GET")
    opener = urllib.request.build_opener(_NoRedirect)
    with opener.open(request, timeout=timeout) as response:
        raw = response.read(MAX_HTTP_BYTES + 1)
        if len(raw) > MAX_HTTP_BYTES:
            raise ReadActionError("response_too_large")
        return json.loads(raw.decode())


def _default_git_run(root, args, timeout=10):
    env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C"}
    result = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True,
                            timeout=timeout, env=env, shell=False, check=False)
    if result.returncode != 0:
        raise ReadActionError("git_read_failed")
    return result.stdout[:20000]


def _redact_json(value, depth=0):
    if depth > 5:
        return str(value)[:500]
    if isinstance(value, dict):
        out = {}
        for key, item in list(value.items())[:64]:
            name = str(key)[:100]
            out[name] = "[REDACTED]" if SENSITIVE_KEY.search(name) else _redact_json(item, depth + 1)
        return out
    if isinstance(value, list):
        return [_redact_json(item, depth + 1) for item in value[:64]]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:2000]


def _redact_text(text):
    lines = []
    for line in str(text).splitlines()[:1000]:
        lines.append("[REDACTED LINE]" if SENSITIVE_KEY.search(line) else line[:2000])
    return "\n".join(lines)[:60000]


class ReadToolExecutor:
    def __init__(self, bindings, github_get=None, runtime_get=None, git_run=None, gh_runner=None):
        self.bindings = bindings
        self.github_get = github_get or _default_json_get
        self.runtime_get = runtime_get or _default_json_get
        self.git_run = git_run or _default_git_run
        self.gh_runner = gh_runner or subprocess.run

    def execute(self, action):
        project_id = str(action.get("project_id") or "")
        project = self.bindings.get(project_id)
        if not project:
            raise ReadActionError("project_tools_unconfigured")
        kind = str(action.get("type") or "")
        if kind == "github.read": return self._github(project, str(action.get("target") or ""))
        if kind == "runtime.read": return self._runtime(project, str(action.get("target") or ""))
        if kind == "git.read": return self._git(project, str(action.get("target") or ""))
        if kind == "evidence.read": return self._evidence(project, str(action.get("target") or ""))
        raise ReadActionError("action_not_read_only")

    def _github(self, project, target):
        parts = target.split(":", 2)
        if len(parts) != 3 or not ALIAS.fullmatch(parts[0]):
            raise ReadActionError("invalid_github_target")
        alias, resource, identity = parts
        binding = project["github"].get(alias)
        if not binding: raise ReadActionError("github_alias_not_allowed")
        if resource not in {"issue", "pr", "commit", "run"} or not identity or len(identity) > 80:
            raise ReadActionError("invalid_github_target")
        if resource in {"issue", "pr", "run"} and not identity.isdigit():
            raise ReadActionError("invalid_github_identity")
        if resource == "commit" and not re.fullmatch(r"[A-Fa-f0-9]{7,64}", identity):
            raise ReadActionError("invalid_github_identity")
        repo = binding["repository"]
        path = {"issue":f"issues/{identity}", "pr":f"pulls/{identity}",
                "commit":f"commits/{identity}", "run":f"actions/runs/{identity}"}[resource]
        try:
            if binding.get("use_gh_auth"):
                raw = self._github_via_gh(repo, path)
            else:
                headers = {"Accept":"application/vnd.github+json", "User-Agent":"chatgpt-autopilot-browserless"}
                if binding.get("token"): headers["Authorization"] = f"Bearer {binding['token']}"
                raw = self.github_get(f"https://api.github.com/repos/{repo}/{path}", headers)
        except ReadActionError: raise
        except Exception: raise ReadActionError("github_read_failed") from None
        return {"ok": True, "kind":"github", "alias":alias, "resource":resource,
                "identity":identity, "data":self._github_safe(resource, raw)}

    def _github_via_gh(self, repo, path):
        command = ["gh", "api", "--hostname", "github.com", "--method", "GET", f"repos/{repo}/{path}"]
        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", ""),
            "GH_HOST": "github.com",
            "GH_PROMPT_DISABLED": "1",
            "GIT_TERMINAL_PROMPT": "0",
        }
        if os.environ.get("XDG_CONFIG_HOME"):
            env["XDG_CONFIG_HOME"] = os.environ["XDG_CONFIG_HOME"]
        try:
            result = self.gh_runner(command, capture_output=True, text=True, check=False, env=env, timeout=15)
        except Exception:
            raise ReadActionError("github_read_failed") from None
        if int(getattr(result, "returncode", 1)) != 0:
            raise ReadActionError("github_read_failed")
        output = str(getattr(result, "stdout", "") or "")
        if len(output.encode()) > MAX_HTTP_BYTES:
            raise ReadActionError("github_response_too_large")
        try:
            raw = json.loads(output)
        except json.JSONDecodeError:
            raise ReadActionError("github_invalid_json") from None
        if not isinstance(raw, dict):
            raise ReadActionError("github_invalid_json")
        return raw

    @staticmethod
    def _github_safe(resource, raw):
        if resource == "issue":
            return {"number":raw.get("number"), "title":str(raw.get("title") or "")[:500],
                    "state":raw.get("state"), "state_reason":raw.get("state_reason"),
                    "labels":sorted(str((x or {}).get("name") or "")[:120] for x in raw.get("labels",[])[:32]),
                    "body_sha256":hashlib.sha256(str(raw.get("body") or "").encode()).hexdigest()}
        if resource == "pr":
            return {"number":raw.get("number"), "title":str(raw.get("title") or "")[:500], "state":raw.get("state"),
                    "merged":bool(raw.get("merged")), "draft":bool(raw.get("draft")),
                    "head_sha":(raw.get("head") or {}).get("sha"), "base_sha":(raw.get("base") or {}).get("sha"),
                    "merge_commit_sha":raw.get("merge_commit_sha")}
        if resource == "commit":
            commit = raw.get("commit") or {}
            return {"sha":str(raw.get("sha") or "")[:64], "message":str(commit.get("message") or "")[:1000],
                    "date":((commit.get("committer") or {}).get("date")),
                    "parents":[str((p or {}).get("sha") or "")[:64] for p in raw.get("parents",[])[:8]]}
        return {"id":raw.get("id"), "name":str(raw.get("name") or "")[:300], "status":raw.get("status"),
                "conclusion":raw.get("conclusion"), "head_sha":str(raw.get("head_sha") or "")[:64],
                "run_number":raw.get("run_number"), "run_attempt":raw.get("run_attempt"), "event":raw.get("event")}

    def _runtime(self, project, target):
        if not ALIAS.fullmatch(target): raise ReadActionError("invalid_runtime_target")
        binding = project["runtime"].get(target)
        if not binding: raise ReadActionError("runtime_alias_not_allowed")
        try:
            raw = self.runtime_get(binding["url"], {"Accept":"application/json", "User-Agent":"chatgpt-autopilot-browserless"})
        except ReadActionError: raise
        except Exception: raise ReadActionError("runtime_read_failed") from None
        if not isinstance(raw, dict): raise ReadActionError("runtime_invalid_json")
        try:
            _subject, document = runtime_observation({"component":target, **raw})
        except ValueError: raise ReadActionError("runtime_unusable_health") from None
        return {"ok": True, "kind":"runtime", "alias":target, "data":document["material"]}

    def _git(self, project, target):
        parts = target.split(":")
        if len(parts) < 2 or not ALIAS.fullmatch(parts[0]): raise ReadActionError("invalid_git_target")
        alias, op = parts[0], parts[1]
        binding = project["git"].get(alias)
        if not binding: raise ReadActionError("git_alias_not_allowed")
        commands = {"head":["rev-parse","HEAD"], "branch":["branch","--show-current"],
                    "status":["status","--short","--untracked-files=no"], "diffstat":["diff","--stat"]}
        if op == "log":
            if len(parts) != 3 or not parts[2].isdigit(): raise ReadActionError("invalid_git_target")
            count = max(1, min(20, int(parts[2]))); args = ["log","-n",str(count),"--oneline","--no-decorate"]
        else:
            if len(parts) != 2 or op not in commands: raise ReadActionError("invalid_git_target")
            args = commands[op]
        try: output = self.git_run(binding["path"], args)
        except ReadActionError: raise
        except Exception: raise ReadActionError("git_read_failed") from None
        text = str(output)[:20000]
        return {"ok": True, "kind":"git", "alias":alias, "operation":op,
                "output":text, "output_sha256":hashlib.sha256(text.encode()).hexdigest()}

    def _evidence(self, project, target):
        if ":" not in target: raise ReadActionError("invalid_evidence_target")
        alias, relative = target.split(":", 1)
        if not ALIAS.fullmatch(alias) or not relative or len(relative) > 240:
            raise ReadActionError("invalid_evidence_target")
        binding = project["evidence"].get(alias)
        if not binding: raise ReadActionError("evidence_alias_not_allowed")
        root = Path(binding["root"]).resolve(); candidate = (root / relative).resolve()
        try: candidate.relative_to(root)
        except ValueError: raise ReadActionError("evidence_path_escape") from None
        if candidate.suffix.lower() not in {".json", ".md", ".txt"} or not candidate.is_file():
            raise ReadActionError("evidence_file_not_allowed")
        if candidate.stat().st_size > MAX_FILE_BYTES: raise ReadActionError("evidence_file_too_large")
        raw = candidate.read_text(encoding="utf-8")
        digest = hashlib.sha256(raw.encode()).hexdigest()
        if candidate.suffix.lower() == ".json":
            try: content = _redact_json(json.loads(raw))
            except json.JSONDecodeError: raise ReadActionError("evidence_invalid_json") from None
        else:
            content = _redact_text(raw)
        return {"ok": True, "kind":"evidence", "alias":alias, "file":relative,
                "sha256":digest, "content":content}
