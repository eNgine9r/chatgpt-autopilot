#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  echo "Run this installer as the normal Autopilot user, not with sudo."
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME:?HOME is required}"
USER_ID="$(id -u)"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME_DIR/.config}/systemd/user"
SERVICE="$SERVICE_DIR/chatgpt-project-autopilot.service"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$USER_ID}"

node_major() {
  "$1" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
}

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ ! -x "$NODE_BIN" ]] || (( $(node_major "$NODE_BIN") < 22 )); then
  NODE_BIN=""
  while IFS= read -r candidate; do
    if [[ -x "$candidate" ]] && (( $(node_major "$candidate") >= 22 )); then
      NODE_BIN="$candidate"
    fi
  done < <(find "$HOME_DIR/.nvm/versions/node" -type f -path '*/bin/node' 2>/dev/null | sort -V)
fi

[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || {
  echo "Node.js 22+ executable not found for $(id -un)"
  exit 1
}
[[ -f "$APP_DIR/.env" ]] || { echo "Missing $APP_DIR/.env"; exit 1; }
[[ -f "$APP_DIR/config/projects.json" ]] || { echo "Missing $APP_DIR/config/projects.json"; exit 1; }
[[ -S "$RUNTIME_DIR/bus" ]] || {
  echo "User systemd bus is unavailable at $RUNTIME_DIR/bus. Log into the desktop/session first."
  exit 1
}

mkdir -p "$SERVICE_DIR"
TMP="$(mktemp "$SERVICE_DIR/.autopilot-service.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
sed \
  -e "s|__HOME__|$HOME_DIR|g" \
  -e "s|__APP_DIR__|$APP_DIR|g" \
  -e "s|__NODE__|$NODE_BIN|g" \
  "$APP_DIR/systemd/chatgpt-project-autopilot.service.template" > "$TMP"
chmod 0644 "$TMP"
mv "$TMP" "$SERVICE"
trap - EXIT

export XDG_RUNTIME_DIR="$RUNTIME_DIR"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$RUNTIME_DIR/bus}"
systemctl --user daemon-reload
systemctl --user enable --now chatgpt-project-autopilot.service

echo "Installed user service: $SERVICE"
echo "Node: $NODE_BIN ($($NODE_BIN --version))"
echo "Linger: $(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo unknown)"
systemctl --user --no-pager --full status chatgpt-project-autopilot.service || true
