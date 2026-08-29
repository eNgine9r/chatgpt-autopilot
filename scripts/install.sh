#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null || { echo "Node.js 22+ is required."; exit 1; }
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= 22 )) || { echo "Node.js 22+ is required."; exit 1; }

chromium_bin="$(command -v chromium || command -v chromium-browser || true)"
[[ -n "$chromium_bin" ]] || {
  echo "Host Chromium is required. Install it with the OS package manager first."
  exit 1
}

[[ -f .env ]] || cp .env.example .env
[[ -f config/projects.json ]] || cp config/projects.example.json config/projects.json
mkdir -p browser-profile/.cache browser-profile/.config state logs
chmod 700 browser-profile browser-profile/.cache browser-profile/.config state logs
chmod 600 .env config/projects.json

if grep -q '^CHROMIUM_EXECUTABLE_PATH=' .env; then
  sed -i "s|^CHROMIUM_EXECUTABLE_PATH=.*$|CHROMIUM_EXECUTABLE_PATH=$chromium_bin|" .env
else
  printf '\nCHROMIUM_EXECUTABLE_PATH=%s\n' "$chromium_bin" >> .env
fi

npm install --ignore-scripts

echo
echo "Installed using host Chromium: $chromium_bin"
echo "Node: $(command -v node) ($(node --version))"
echo "1) Edit config/projects.json"
echo "2) Edit .env for optional Telegram alerts"
echo "3) Run: npm run login"
echo "4) Test: npm test && npm run check"
echo "5) After foreground acceptance: sudo ./scripts/install-systemd.sh"
