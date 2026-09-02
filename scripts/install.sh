#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

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
  done < <(find "$HOME/.nvm/versions/node" -type f -path '*/bin/node' 2>/dev/null | sort -V)
fi

[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "Node.js 22+ is required."; exit 1; }
NPM_BIN="$(dirname "$NODE_BIN")/npm"
[[ -x "$NPM_BIN" ]] || { echo "npm for $NODE_BIN was not found."; exit 1; }

[[ -f .env ]] || cp .env.example .env
[[ -f config/projects.json ]] || cp config/projects.example.json config/projects.json
mkdir -p browser-profile logs
chmod 700 browser-profile logs
chmod 600 .env config/projects.json

chromium_path="${CHROMIUM_EXECUTABLE_PATH:-$(awk -F= '/^CHROMIUM_EXECUTABLE_PATH=/{print $2}' .env | tail -1)}"
chromium_path="${chromium_path:-/usr/bin/chromium}"
[[ -x "$chromium_path" ]] || { echo "Chromium not executable: $chromium_path"; exit 1; }

"$NPM_BIN" install --ignore-scripts

echo
echo "Installed with ordinary host Chromium: $chromium_path"
echo "Node: $NODE_BIN ($($NODE_BIN --version))"
echo "1) Edit config/projects.json"
echo "2) Edit .env (DISPLAY/XAUTHORITY and optional Telegram)"
echo "3) Stop user service if present, then run: npm run login"
echo "4) Test: npm test && npm run check"
echo "5) After foreground acceptance: ./scripts/install-systemd.sh"
