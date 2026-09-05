#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID:-$(id -u)} -eq 0 ]]; then echo "Run as the normal Autopilot user, not sudo."; exit 1; fi
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME:?HOME is required}"
USER_ID="$(id -u)"; USER_NAME="$(id -un)"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME_DIR/.config}/systemd/user"
SERVICE="$SERVICE_DIR/chatgpt-autopilot-control-hub.service"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$USER_ID}"
node_major(){ "$1" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0; }
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ ! -x "$NODE_BIN" ]] || (( $(node_major "$NODE_BIN") < 22 )); then
  NODE_BIN=""
  while IFS= read -r candidate; do
    if [[ -x "$candidate" ]] && (( $(node_major "$candidate") >= 22 )); then NODE_BIN="$candidate"; fi
  done < <(find "$HOME_DIR/.nvm/versions/node" -type f -path '*/bin/node' 2>/dev/null | sort -V)
fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "Node.js 22+ not found"; exit 1; }
[[ -f "$APP_DIR/.env" ]] || { echo "Missing $APP_DIR/.env"; exit 1; }
[[ -f "$APP_DIR/config/control-workers.json" ]] || { echo "Missing config/control-workers.json"; exit 1; }
[[ -S "$RUNTIME_DIR/bus" ]] || { echo "User systemd bus unavailable: $RUNTIME_DIR/bus"; exit 1; }
mkdir -p "$SERVICE_DIR"
TMP="$(mktemp "$SERVICE_DIR/.autopilot-hub.XXXXXX")"; trap 'rm -f "$TMP"' EXIT
sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__NODE__|$NODE_BIN|g" -e "s|__RUNTIME_DIR__|$RUNTIME_DIR|g" \
  "$APP_DIR/systemd/chatgpt-autopilot-control-hub.service.template" > "$TMP"
chmod 0644 "$TMP"; mv "$TMP" "$SERVICE"; trap - EXIT
export XDG_RUNTIME_DIR="$RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$RUNTIME_DIR/bus}"
loginctl enable-linger "$USER_NAME" >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable --now chatgpt-autopilot-control-hub.service
echo "Installed control hub: $SERVICE"
systemctl --user --no-pager --full status chatgpt-autopilot-control-hub.service || true
