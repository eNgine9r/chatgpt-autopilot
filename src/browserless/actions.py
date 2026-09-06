READ_ONLY_ACTION_TYPES = ("github.read", "runtime.read", "git.read", "evidence.read", "repo.read")
WORKSPACE_ACTION_TYPES = ("repo.prepare", "repo.test")
SAFE_ACTION_TYPES = READ_ONLY_ACTION_TYPES + WORKSPACE_ACTION_TYPES
MAX_ACTIONS = 8

ACTION_SCHEMA = {
    "type": "array", "maxItems": MAX_ACTIONS,
    "items": {
        "type": "object", "additionalProperties": False,
        "required": ["type", "target", "purpose"],
        "properties": {
            "type": {"type": "string", "enum": list(SAFE_ACTION_TYPES)},
            "target": {"type": "string", "maxLength": 512},
            "purpose": {"type": "string", "maxLength": 500},
        },
    },
}


def validate_actions(actions):
    if not isinstance(actions, list) or len(actions) > MAX_ACTIONS:
        raise ValueError("invalid_actions")
    normalized = []
    for action in actions:
        if not isinstance(action, dict) or set(action) != {"type", "target", "purpose"}:
            raise ValueError("invalid_action_shape")
        kind = str(action.get("type") or "")
        if kind not in SAFE_ACTION_TYPES:
            raise ValueError("action_not_allowed")
        target = str(action.get("target") or "")[:512]
        purpose = str(action.get("purpose") or "")[:500]
        if not target or not purpose:
            raise ValueError("invalid_action_fields")
        normalized.append({"type": kind, "target": target, "purpose": purpose})
    return normalized
