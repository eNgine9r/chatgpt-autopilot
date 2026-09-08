#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  echo "Node.js is required" >&2
  exit 1
fi

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit="$unit_dir/chatgpt-autopilot-v3.service"
template="$repo_dir/systemd/chatgpt-autopilot-v3.service.template"
state_dir="$repo_dir/state-v3"
secret_file="$state_dir/github-webhook.secret"
mkdir -p "$unit_dir" "$state_dir"
chmod 700 "$state_dir"

if [[ ! -f "$secret_file" ]]; then
  "$node_bin" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "$secret_file"
fi
chmod 600 "$secret_file"

escaped_repo=${repo_dir//|/\\|}
escaped_node=${node_bin//|/\\|}
escaped_secret=${secret_file//|/\\|}sed \
  -e "s|__REPO_DIR__|$escaped_repo|g" \
  -e "s|__NODE_BIN__|$escaped_node|g" \
  -e "s|__GITHUB_SECRET_FILE__|$escaped_secret|g" \
  "$template" > "$unit"
chmod 600 "$unit"

if [[ ! -f "$repo_dir/config/v3-projects.json" ]]; then
  cp "$repo_dir/config/v3-projects.example.json" "$repo_dir/config/v3-projects.json"
  chmod 600 "$repo_dir/config/v3-projects.json"
fi

systemctl --user daemon-reload
echo "Installed chatgpt-autopilot-v3.service (disabled, not started)."
echo "Generated/preserved a private GitHub webhook secret in state-v3/."
echo "Run acceptance first; enable only after explicit approval."