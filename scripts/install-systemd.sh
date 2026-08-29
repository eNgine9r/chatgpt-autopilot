#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Run with sudo."; exit 1; }
CALLER="${SUDO_USER:-}"
[[ -n "$CALLER" && "$CALLER" != root ]] || { echo "Run as: sudo ./scripts/install-systemd.sh"; exit 1; }

HOME_DIR="$(getent passwd "$CALLER" | cut -d: -f6)"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="/etc/systemd/system/chatgpt-project-autopilot.service"

sed \
  -e "s|__USER__|$CALLER|g" \
  -e "s|__HOME__|$HOME_DIR|g" \
  -e "s|__APP_DIR__|$APP_DIR|g" \
  "$APP_DIR/systemd/chatgpt-project-autopilot.service.template" > "$SERVICE"

chmod 0644 "$SERVICE"
systemctl daemon-reload
systemctl enable --now chatgpt-project-autopilot.service

echo "Installed: $SERVICE"
systemctl --no-pager --full status chatgpt-project-autopilot.service || true
