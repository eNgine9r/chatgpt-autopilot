import json
import os
import urllib.error
import urllib.request

from .actions import ACTION_SCHEMA, validate_actions

MODEL = "gpt-5.6-luna"
RESPONSES_URL = "https://api.openai.com/v1/responses"


class MissingCredentialError(RuntimeError):
    pass


class InvalidModelResponse(RuntimeError):
    pass


DECISION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["decision", "message", "actions", "checkpoint"],
    "properties": {
        "decision": {"type": "string", "enum": ["continue", "wait", "user_action_required", "complete", "escalation_required"]},
        "message": {"type": "string"},
        "actions": ACTION_SCHEMA,
        "checkpoint": {
            "type": "object",
            "additionalProperties": False,
            "required": ["goal", "completed", "currentTask", "decisions", "evidence", "blockers", "nextAction", "doNotRepeat", "planVersion", "stage", "githubPr"],
            "properties": {
                "goal": {"type": "string"},
                "completed": {"type": "array", "items": {"type": "string"}},
                "currentTask": {"type": "string"},
                "decisions": {"type": "array", "items": {"type": "string"}},
                "evidence": {"type": "array", "items": {"type": "string"}},
                "blockers": {"type": "array", "items": {"type": "string"}},
                "nextAction": {"type": "string"},
                "doNotRepeat": {"type": "array", "items": {"type": "string"}},
                "planVersion": {"type": "string", "enum": ["2026-09-04-v1"]},
                "stage": {"type": "string", "enum": ["active", "complete"]},
                "githubPr": {"type": "integer", "minimum": 0},
            },
        },
    },
}


def _default_transport(url, headers, body, timeout):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:1000]
        raise RuntimeError(f"openai_http_{exc.code}:{detail}") from None


def _output_text(payload: dict) -> str:
    for item in payload.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") in {"output_text", "text"} and content.get("text"):
                return str(content["text"])
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"]
    raise InvalidModelResponse("missing_output_text")


def _usage(payload: dict) -> dict:
    usage = payload.get("usage") or {}
    details = usage.get("input_tokens_details") or {}
    return {
        "input_tokens": int(usage.get("input_tokens") or 0),
        "cached_input_tokens": int(details.get("cached_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
    }


def _validate_decision(decision):
    if not isinstance(decision, dict) or decision.get("decision") not in {"continue", "wait", "user_action_required", "complete", "escalation_required"}:
        raise InvalidModelResponse("invalid_decision")
    if not isinstance(decision.get("message"), str) or not isinstance(decision.get("checkpoint"), dict):
        raise InvalidModelResponse("invalid_decision_shape")
    try:
        decision["actions"] = validate_actions(decision.get("actions"))
    except ValueError as exc:
        raise InvalidModelResponse(str(exc)) from exc
    if decision["decision"] != "continue" and decision["actions"]:
        raise InvalidModelResponse("actions_require_continue_decision")
    checkpoint = decision["checkpoint"]
    required = {"goal", "completed", "currentTask", "decisions", "evidence", "blockers", "nextAction", "doNotRepeat", "planVersion", "stage", "githubPr"}
    if not required.issubset(checkpoint) or checkpoint.get("planVersion") != "2026-09-04-v1":
        raise InvalidModelResponse("invalid_checkpoint")
    if checkpoint.get("stage") not in {"active", "complete"}:
        raise InvalidModelResponse("invalid_checkpoint_stage")
    return decision


class LunaResponsesClient:
    def __init__(self, api_key=None, transport=None, timeout=90):
        self.api_key = api_key if api_key is not None else os.getenv("OPENAI_API_KEY", "")
        self.transport = transport or _default_transport
        self.timeout = timeout

    def decide(self, context: str, prompt_cache_key="autopilot-browserless-v1") -> dict:
        if not self.api_key:
            raise MissingCredentialError("OPENAI_API_KEY is not configured for Browserless Autopilot")
        body = {
            "model": MODEL,
            "instructions": "You are Browserless Autopilot. Follow the supplied Plan Anchor and durable checkpoint. Never invent evidence. Fail closed on ambiguity. Never perform or authorize product trading, hardware/Modbus writes, secrets disclosure, browser automation, or unapproved production/site cutovers. requested actions may be only safe evidence/workspace actions (github.read, runtime.read, git.read, evidence.read, repo.read, repo.prepare, repo.test). repo.prepare may create only the configured isolated worktree and repo.test may run only a configured sandboxed test alias. Code patching, commits, pushes, merges, deploys, browser automation, trading, hardware/Modbus writes, secrets disclosure, and unapproved production/site cutovers are forbidden in this phase. If such an action is required, return user_action_required or escalation_required instead. Return only the required structured decision.",
            "store": False,
            "reasoning": {"effort": "low"},
            "input": context,
            "max_output_tokens": 4096,
            "prompt_cache_key": prompt_cache_key,
            "text": {"format": {"type": "json_schema", "name": "autopilot_decision", "strict": True, "schema": DECISION_SCHEMA}},
        }
        payload = self.transport(RESPONSES_URL, {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}, body, self.timeout)
        if payload.get("status") not in {None, "completed"}:
            raise InvalidModelResponse(f"response_status_{payload.get('status')}")
        try:
            decision = json.loads(_output_text(payload))
        except (json.JSONDecodeError, TypeError) as exc:
            raise InvalidModelResponse("invalid_structured_json") from exc
        decision = _validate_decision(decision)
        return {"response_id": str(payload.get("id") or ""), "decision": decision, "usage": _usage(payload)}
