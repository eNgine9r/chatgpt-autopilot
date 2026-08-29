#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null || { echo "Node.js 22+ is required."; exit 1; }
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= 22 )) || { echo "Node.js 22+ is required."; exit 1; }

[[ -f .env ]] || cp .env.example .env
[[ -f config/projects.json ]] || cp config/projects.example.json config/projects.json
mkdir -p browser-profile logs
chmod 700 browser-profile logs
chmod 600 .env config/projects.json

chromium_path="${CHROMIUM_EXECUTABLE_PATH:-$(awk -F= '/^CHROMIUM_EXECUTABLE_PATH=/{print $2}' .env | tail -1)}"
chromium_path="${chromium_path:-/usr/bin/chromium}"
[[ -x "$chromium_path" ]] || { echo "Chromium not executable: $chromium_path"; exit 1; }

npm install --ignore-scripts

echo
echo "Installed with ordinary host Chromium: $chromium_path"
echo "Node: $(command -v node) ($(node --version))"
echo "1) Edit config/projects.json"
echo "2) Edit .env (DISPLAY/XAUTHORITY and optional Telegram)"
echo "3) Stop background service if present, then run: npm run login"
echo "4) Test: npm test && npm run check"
echo "5) After foreground acceptance: sudo ./scripts/install-systemd.sh"
