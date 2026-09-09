#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  echo "Node.js is required" >&2
  exit 1
fi
if [[ ! -f "$repo_dir/.env" ]]; then
  echo ".env is required for Telegram credentials" >&2
  exit 1
fi
if [[ ! -f "$repo_dir/config/v3-projects.json" ]]; then
  echo "config/v3-projects.json is required" >&2
  exit 1
fi
for key in TELEGRAM_BOT_TOKEN TELEGRAM_OWNER_USER_ID; do
  if ! grep -q "^${key}=" "$repo_dir/.env"; then
    echo "$key is required in .env" >&2
    exit 1
  fi
done
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit="$unit_dir/chatgpt-autopilot-v3-miniapp.service"
template="$repo_dir/systemd/chatgpt-autopilot-v3-miniapp.service.template"
mkdir -p "$unit_dir" "$repo_dir/state-v3"
chmod 700 "$repo_dir/state-v3"

escaped_repo=${repo_dir//|/\\|}
escaped_node=${node_bin//|/\\|}
sed \
  -e "s|__REPO_DIR__|$escaped_repo|g" \
  -e "s|__NODE_BIN__|$escaped_node|g" \
  "$template" > "$unit"
chmod 600 "$unit"

systemctl --user daemon-reload
echo "Installed chatgpt-autopilot-v3-miniapp.service (disabled, not started)."
echo "Listener stays on 127.0.0.1:8782; do not expose v3 control port 8780."
echo "Run local Mini App acceptance before Funnel cutover."
