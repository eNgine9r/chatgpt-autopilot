#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null || { echo "Node.js 22+ is required."; exit 1; }
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= 22 )) || { echo "Node.js 22+ is required."; exit 1; }

[[ -f .env ]] || cp .env.example .env
[[ -f config/projects.json ]] || cp config/projects.example.json config/projects.json
mkdir -p browser-profile state logs
chmod 700 browser-profile state logs
chmod 600 .env config/projects.json

npm install
npx playwright install chromium

echo
echo "Installed."
echo "1) Edit config/projects.json"
echo "2) Edit .env for optional Telegram alerts"
echo "3) Run: npm run login"
echo "4) Test: npm test && npm run check"
echo "5) After foreground acceptance: sudo ./scripts/install-systemd.sh"
