#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Run with sudo."; exit 1; }
CALLER="${SUDO_USER:-}"
[[ -n "$CALLER" && "$CALLER" != root ]] || { echo "Run as: sudo ./scripts/install-systemd.sh"; exit 1; }

HOME_DIR="$(getent passwd "$CALLER" | cut -d: -f6)"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="/etc/systemd/system/chatgpt-project-autopilot.service"

NODE_BIN=""
for candidate in "$HOME_DIR"/.nvm/versions/node/v*/bin/node /usr/local/bin/node /usr/bin/node; do
  [[ -x "$candidate" ]] || continue
  major="$($candidate -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  if (( major >= 22 )); then NODE_BIN="$candidate"; fi
done
[[ -n "$NODE_BIN" ]] || { echo "No Node.js 22+ binary found for $CALLER."; exit 1; }

CHROMIUM_BIN="$(grep -E '^CHROMIUM_EXECUTABLE_PATH=' "$APP_DIR/.env" | tail -1 | cut -d= -f2-)"
[[ -x "$CHROMIUM_BIN" ]] || { echo "Configured Chromium is missing or not executable: $CHROMIUM_BIN"; exit 1; }

sed \
  -e "s|__USER__|$CALLER|g" \
  -e "s|__HOME__|$HOME_DIR|g" \
  -e "s|__APP_DIR__|$APP_DIR|g" \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  "$APP_DIR/systemd/chatgpt-project-autopilot.service.template" > "$SERVICE"

chmod 0644 "$SERVICE"
systemctl daemon-reload
systemctl enable --now chatgpt-project-autopilot.service

echo "Installed: $SERVICE"
echo "Node: $NODE_BIN"
echo "Chromium: $CHROMIUM_BIN"
systemctl --no-pager --full status chatgpt-project-autopilot.service || true
