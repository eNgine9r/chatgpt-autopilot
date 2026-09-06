import argparse
import hashlib
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .ingress import ingest_observation
from .sources import github_observation, runtime_observation
from .store import BrowserlessStore

MAX_BODY_BYTES = 262144
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _secret(env, name):
    value = str(env.get(name) or "")
    if not value:
        raise ValueError(f"missing ingress secret env: {name}")
    return value.encode()


def load_bindings(path, env=None):
    env = os.environ if env is None else env
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    result = {"github": {}, "runtime": {}}
    for project_id, raw in (doc.get("github") or {}).items():
        repo = str((raw or {}).get("repository") or "")
        secret_env = str((raw or {}).get("secretEnv") or "")
        if not project_id or "/" not in repo or not secret_env:
            raise ValueError(f"invalid github ingress binding: {project_id}")
        result["github"][str(project_id)] = {"repository": repo, "secret": _secret(env, secret_env)}
    for project_id, raw in (doc.get("runtime") or {}).items():
        components = {str(item) for item in list((raw or {}).get("components") or []) if str(item)}
        secret_env = str((raw or {}).get("secretEnv") or "")
        if not project_id or not components or not secret_env:
            raise ValueError(f"invalid runtime ingress binding: {project_id}")
        result["runtime"][str(project_id)] = {"components": components, "secret": _secret(env, secret_env)}
    return result


def _valid_signature(secret, body, supplied):
    if not secret or not supplied:
        return False
    expected = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, str(supplied))


class IngressServer(HTTPServer):
    def __init__(self, address, db_path, bindings):
        super().__init__(address, IngressHandler)
        self.db_path = db_path
        self.bindings = bindings


class IngressHandler(BaseHTTPRequestHandler):
    server_version = "AutopilotBrowserlessIngress/1"

    def log_message(self, _format, *_args):
        return

    def _reply(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path != "/health":
            self._reply(404, {"ok": False, "error": "not_found"})
            return
        store = BrowserlessStore(self.server.db_path)
        try:
            counts = store.counts()
        finally:
            store.close()
        self._reply(200, {"ok": True, "mode": "browserless_ingress", "projects": counts["projects"],
                          "observations": counts["observations"], "events": counts["events"]})

    def _body(self):
        if not str(self.headers.get("Content-Type") or "").lower().startswith("application/json"):
            self._reply(415, {"ok": False, "error": "application_json_required"})
            return None
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY_BYTES:
            self._reply(413, {"ok": False, "error": "body_too_large"})
            return None
        return self.rfile.read(length)

    def do_POST(self):
        parts = [item for item in urlparse(self.path).path.split("/") if item]
        if len(parts) != 3 or parts[0] != "v1" or parts[1] not in {"github", "runtime"}:
            self._reply(404, {"ok": False, "error": "not_found"})
            return
        source, project_id = parts[1], parts[2]
        binding = self.server.bindings.get(source, {}).get(project_id)
        if not binding:
            self._reply(404, {"ok": False, "error": "unknown_binding"})
            return
        body = self._body()
        if body is None:
            return
        signature_header = "X-Hub-Signature-256" if source == "github" else "X-Autopilot-Signature-256"
        if not _valid_signature(binding["secret"], body, self.headers.get(signature_header)):
            self._reply(401, {"ok": False, "error": "invalid_signature"})
            return
        try:
            payload = json.loads(body.decode())
            if source == "github":
                repository = str((payload.get("repository") or {}).get("full_name") or "")
                if repository != binding["repository"]:
                    self._reply(403, {"ok": False, "error": "repository_mismatch"})
                    return
                event_name = str(self.headers.get("X-GitHub-Event") or "")
                if event_name == "ping":
                    self._reply(200, {"ok": True, "ping": True, "projectId": project_id})
                    return
                if event_name == "workflow_run":
                    run = payload.get("workflow_run") if isinstance(payload.get("workflow_run"), dict) else {}
                    if str(run.get("status") or "") != "completed":
                        self._reply(200, {"ok": True, "ignored": True, "reason": "workflow_not_terminal",
                                          "projectId": project_id})
                        return
                subject, document = github_observation(event_name, payload)
            else:
                component = str(payload.get("component") or "")
                if component not in binding["components"]:
                    self._reply(403, {"ok": False, "error": "component_not_allowed"})
                    return
                subject, document = runtime_observation(payload)
            store = BrowserlessStore(self.server.db_path)
            try:
                result = ingest_observation(store, project_id, source, subject, document)
            finally:
                store.close()
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._reply(400, {"ok": False, "error": "invalid_json"})
            return
        except (ValueError, KeyError):
            self._reply(422, {"ok": False, "error": "invalid_observation"})
            return
        self._reply(202 if result["changed"] else 200,
                    {"ok": True, "changed": result["changed"], "revision": result["revision"],
                     "source": source, "subject": subject})


def create_server(db_path, bindings, host="127.0.0.1", port=8771):
    if host not in LOOPBACK_HOSTS:
        raise ValueError("browserless ingress must bind to loopback")
    store = BrowserlessStore(db_path)
    try:
        known = set(store.project_ids())
    finally:
        store.close()
    configured = set(bindings.get("github", {})) | set(bindings.get("runtime", {}))
    unknown = sorted(configured - known)
    if unknown:
        raise ValueError(f"ingress binding references unknown projects: {','.join(unknown)}")
    return IngressServer((host, int(port)), db_path, bindings)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Authenticated loopback event ingress for Browserless Autopilot")
    parser.add_argument("--db", required=True)
    parser.add_argument("--bindings", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8771)
    args = parser.parse_args(argv)
    server = create_server(args.db, load_bindings(args.bindings), args.host, args.port)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
