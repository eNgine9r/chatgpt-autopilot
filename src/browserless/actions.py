READ_ONLY_ACTION_TYPES = ("github.read", "runtime.read", "git.read", "evidence.read", "repo.read")
WORKSPACE_ACTION_TYPES = ("repo.prepare", "repo.patch", "repo.test")
SAFE_ACTION_TYPES = READ_ONLY_ACTION_TYPES + WORKSPACE_ACTION_TYPES
MAX_ACTIONS = 8
MAX_ACTION_PAYLOAD_CHARS = 20000

ACTION_SCHEMA = {
    "type": "array", "maxItems": MAX_ACTIONS,
    "items": {
        "type": "object", "additionalProperties": False,
        "required": ["type", "target", "purpose", "payload"],
        "properties": {
            "type": {"type": "string", "enum": list(SAFE_ACTION_TYPES)},
            "target": {"type": "string", "maxLength": 512},
            "purpose": {"type": "string", "maxLength": 500},
            "payload": {"type": "string", "maxLength": MAX_ACTION_PAYLOAD_CHARS},
        },
    },
}


def validate_actions(actions):
    if not isinstance(actions, list) or len(actions) > MAX_ACTIONS:
        raise ValueError("invalid_actions")
    normalized = []
    for action in actions:
        if not isinstance(action, dict) or set(action) != {"type", "target", "purpose", "payload"}:
            raise ValueError("invalid_action_shape")
        kind = str(action.get("type") or "")
        if kind not in SAFE_ACTION_TYPES:
            raise ValueError("action_not_allowed")
        target = str(action.get("target") or "")[:512]
        purpose = str(action.get("purpose") or "")[:500]
        payload = str(action.get("payload") or "")
        if len(payload) > MAX_ACTION_PAYLOAD_CHARS:
            raise ValueError("action_payload_too_large")
        if not target or not purpose:
            raise ValueError("invalid_action_fields")
        if kind == "repo.patch":
            if not payload:
                raise ValueError("repo_patch_payload_required")
        elif payload:
            raise ValueError("action_payload_not_allowed")
        normalized.append({"type": kind, "target": target, "purpose": purpose, "payload": payload})
    if any(item["type"] in WORKSPACE_ACTION_TYPES for item in normalized) and len(normalized) != 1:
        raise ValueError("workspace_action_requires_single_step")
    return normalized
