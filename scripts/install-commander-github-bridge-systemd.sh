#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${COMMANDER_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" || "$NODE_BIN" != /* || ! -x "$NODE_BIN" ]]; then
  echo "COMMANDER_NODE_BIN must resolve to an absolute executable path" >&2
  exit 1
fi
NODE_BIN="$(readlink -f "$NODE_BIN")"

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/chatgpt-autopilot-commander"
mkdir -p "$UNIT_DIR" "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

TEMPLATE="$REPO_DIR/systemd/chatgpt-autopilot-commander-github-bridge.service.template"
TARGET="$UNIT_DIR/chatgpt-autopilot-commander-github-bridge.service"
sed -e "s|@REPO_DIR@|$REPO_DIR|g" -e "s|@NODE_BIN@|$NODE_BIN|g" "$TEMPLATE" > "$TARGET"
chmod 644 "$TARGET"

ENV_FILE="$CONFIG_DIR/github-bridge.env"
if [[ ! -e "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<'ENV'
COMMANDER_GITHUB_BRIDGE_ENABLED=false
COMMANDER_GITHUB_REPOSITORY=eNgine9r/chatgpt-autopilot
COMMANDER_GITHUB_ALLOWED_AUTHOR=eNgine9r
COMMANDER_GITHUB_TASK_LABEL=commander/task
COMMANDER_GITHUB_POLL_MS=10000
ENV
  chmod 600 "$ENV_FILE"
fi

if [[ "${COMMANDER_INSTALL_SKIP_SYSTEMD_RELOAD:-0}" != "1" ]]; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
  systemctl --user daemon-reload
fi

echo "Commander GitHub bridge staged only. It was NOT enabled or started."
echo "Bridge unit: $TARGET"
echo "Bridge env:  $ENV_FILE"
