#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Run with sudo."; exit 1; }
CALLER="${SUDO_USER:-}"
[[ -n "$CALLER" && "$CALLER" != root ]] || { echo "Run as: sudo ./scripts/install-systemd.sh"; exit 1; }

HOME_DIR="$(getent passwd "$CALLER" | cut -d: -f6)"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="/etc/systemd/system/chatgpt-project-autopilot.service"

node_major() {
  "$1" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
}

NODE_BIN="$(sudo -u "$CALLER" bash -lc 'command -v node 2>/dev/null || true')"
if [[ ! -x "$NODE_BIN" ]] || (( $(node_major "$NODE_BIN") < 22 )); then
  NODE_BIN=""
  while IFS= read -r candidate; do
    if [[ -x "$candidate" ]] && (( $(node_major "$candidate") >= 22 )); then
      NODE_BIN="$candidate"
    fi
  done < <(find "$HOME_DIR/.nvm/versions/node" -type f -path '*/bin/node' 2>/dev/null | sort -V)
fi

[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || {
  echo "Node.js 22+ executable not found for $CALLER"
  exit 1
}

sed \
  -e "s|__USER__|$CALLER|g" \
  -e "s|__HOME__|$HOME_DIR|g" \
  -e "s|__APP_DIR__|$APP_DIR|g" \
  -e "s|__NODE__|$NODE_BIN|g" \
  "$APP_DIR/systemd/chatgpt-project-autopilot.service.template" > "$SERVICE"

chmod 0644 "$SERVICE"
systemctl daemon-reload
systemctl enable --now chatgpt-project-autopilot.service

echo "Installed: $SERVICE"
echo "Node: $NODE_BIN ($($NODE_BIN --version))"
systemctl --no-pager --full status chatgpt-project-autopilot.service || true
