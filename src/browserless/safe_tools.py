from .read_tools import ReadActionError, ReadToolExecutor
from .workspace_tools import WorkspaceToolExecutor


class SafeToolExecutor:
    def __init__(self, bindings, store=None, read_executor=None, workspace_executor=None):
        self.read = read_executor or ReadToolExecutor(bindings)
        self.workspace = workspace_executor or WorkspaceToolExecutor(bindings, store=store)

    def execute(self, action):
        kind = str(action.get("type") or "")
        if kind in {"github.read", "runtime.read", "git.read", "evidence.read"}:
            return self.read.execute(action)
        if kind in {"repo.read", "repo.prepare", "repo.patch", "repo.test"}:
            return self.workspace.execute(action)
        raise ReadActionError("action_not_allowed")
