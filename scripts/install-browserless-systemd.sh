#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID:-$(id -u)} -eq 0 ]]; then echo "Run as the normal Autopilot user, not sudo."; exit 1; fi
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME:?HOME is required}"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME_DIR/.config}/systemd/user"
SERVICE="$SERVICE_DIR/chatgpt-autopilot-browserless.service"
PYTHON_BIN="$(command -v python3)"
[[ -x "$PYTHON_BIN" ]] || { echo "python3 not found"; exit 1; }
[[ -s "$APP_DIR/.env.local" ]] || { echo "Missing $APP_DIR/.env.local"; exit 1; }
[[ -f "$APP_DIR/config/browserless-tools.json" ]] || { echo "Missing config/browserless-tools.json"; exit 1; }
[[ -f "$APP_DIR/config/browserless-ingress.json" ]] || { echo "Missing config/browserless-ingress.json"; exit 1; }
[[ -f "$APP_DIR/state-browserless/core.sqlite3" ]] || { echo "Missing state-browserless/core.sqlite3; import continuity first"; exit 1; }
chmod 0700 "$APP_DIR/state-browserless"
chmod 0600 "$APP_DIR/.env.local" "$APP_DIR/config/browserless-tools.json" "$APP_DIR/config/browserless-ingress.json" "$APP_DIR/state-browserless/core.sqlite3"
mkdir -p "$SERVICE_DIR"
TMP="$(mktemp "$SERVICE_DIR/.browserless.XXXXXX")"; trap 'rm -f "$TMP"' EXIT
sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__PYTHON__|$PYTHON_BIN|g" \
  "$APP_DIR/systemd/chatgpt-autopilot-browserless.service.template" > "$TMP"
chmod 0644 "$TMP"; mv "$TMP" "$SERVICE"; trap - EXIT
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
systemctl --user daemon-reload
echo "Installed but NOT enabled or started: $SERVICE"
echo "Activation remains a separate production cutover gate."
