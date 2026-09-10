#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js is required" >&2
  exit 1
fi

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/chatgpt-autopilot-commander"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/chatgpt-autopilot-commander"
mkdir -p "$UNIT_DIR" "$CONFIG_DIR" "$STATE_DIR"
chmod 700 "$CONFIG_DIR" "$STATE_DIR"

render_unit() {
  local template="$1" target="$2"
  sed -e "s|@REPO_DIR@|$REPO_DIR|g" -e "s|@NODE_BIN@|$NODE_BIN|g" "$template" > "$target"
  chmod 644 "$target"
}

render_unit "$REPO_DIR/systemd/chatgpt-autopilot-commander-agent.service.template" "$UNIT_DIR/chatgpt-autopilot-commander-agent.service"
render_unit "$REPO_DIR/systemd/chatgpt-autopilot-commander-gateway.service.template" "$UNIT_DIR/chatgpt-autopilot-commander-gateway.service"

if [[ ! -e "$CONFIG_DIR/agent.env" ]]; then
  cat > "$CONFIG_DIR/agent.env" <<'ENV'
COMMANDER_ENABLED=false
COMMANDER_EXECUTION_ENABLED=false
COMMANDER_WRITE_ENABLED=false
COMMANDER_ADMIN_ENABLED=false
COMMANDER_GATEWAY_HOST=127.0.0.1
COMMANDER_GATEWAY_PORT=8790
ENV
  chmod 600 "$CONFIG_DIR/agent.env"
fi
if [[ ! -e "$CONFIG_DIR/gateway.env" ]]; then
  cat > "$CONFIG_DIR/gateway.env" <<'ENV'
COMMANDER_ENABLED=false
COMMANDER_PRIVATE_BIND_ENABLED=false
COMMANDER_EXECUTION_ENABLED=false
COMMANDER_WRITE_ENABLED=false
COMMANDER_ADMIN_ENABLED=false
COMMANDER_GATEWAY_HOST=127.0.0.1
COMMANDER_GATEWAY_PORT=8790
ENV
  chmod 600 "$CONFIG_DIR/gateway.env"
fi

if [[ ! -e "$CONFIG_DIR/read-policy.json" ]]; then
  cat > "$CONFIG_DIR/read-policy.json" <<'JSON'
{
  "version": 1,
  "roots": [],
  "repositories": [],
  "services": []
}
JSON
  chmod 600 "$CONFIG_DIR/read-policy.json"
fi

if [[ ! -e "$CONFIG_DIR/write-policy.json" ]]; then
  cat > "$CONFIG_DIR/write-policy.json" <<'JSON'
{
  "version": 1,
  "roots": [],
  "services": [],
  "repositories": []
}
JSON
  chmod 600 "$CONFIG_DIR/write-policy.json"
fi

if [[ "${COMMANDER_INSTALL_SKIP_SYSTEMD_RELOAD:-0}" != "1" ]]; then
  if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  fi
  if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  fi
  systemctl --user daemon-reload
fi

echo "Commander units staged only. They were NOT enabled or started."
echo "Agent unit:   $UNIT_DIR/chatgpt-autopilot-commander-agent.service"
echo "Gateway unit: $UNIT_DIR/chatgpt-autopilot-commander-gateway.service"
