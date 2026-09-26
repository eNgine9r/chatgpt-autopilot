#!/usr/bin/env bash
set -euo pipefail

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
for cmd in node systemctl tailscale curl getent id readlink; do need "$cmd"; done

if [[ -z "${HOME:-}" ]]; then
  passwd_line="$(getent passwd "$(id -u)")"
  IFS=: read -r _ _ _ _ _ derived_home _ <<< "$passwd_line"
  HOME="${derived_home:-}"
  export HOME
fi
[[ -n "${HOME:-}" && -d "$HOME" ]] || { echo "Unable to resolve HOME" >&2; exit 1; }

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

TAIL_IP="${COMMANDER_REMOTE_MCP_TAILSCALE_IP:-$(tailscale ip -4 | head -1)}"
[[ "$TAIL_IP" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || {
  echo "Refusing non-Tailscale CGNAT bind: $TAIL_IP" >&2
  exit 1
}

PEER_IP="${COMMANDER_REMOTE_MCP_TAILSCALE_PEER_IP:-}"
PEER_ENV_LINE=""
if [[ -n "$PEER_IP" ]]; then
  [[ "$PEER_IP" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || {
    echo "Refusing non-Tailscale peer address: $PEER_IP" >&2
    exit 1
  }
  PEER_ENV_LINE="Environment=COMMANDER_REMOTE_MCP_TAILSCALE_PEER_IP=$PEER_IP"
fi

TOKEN_FILE="${COMMANDER_REMOTE_MCP_TOKEN_FILE:-$HOME/commander-workspaces/.commander-secrets/remote-mcp.token}"
[[ -f "$TOKEN_FILE" ]] || { echo "Commander bearer file missing" >&2; exit 1; }
mode="$(stat -c '%a' "$TOKEN_FILE")"
[[ "$mode" == "600" || "$mode" == "400" ]] || { echo "Commander bearer permissions must be 600 or 400" >&2; exit 1; }
bytes="$(wc -c < "$TOKEN_FILE")"
(( bytes >= 32 && bytes <= 4096 )) || { echo "Commander bearer length invalid" >&2; exit 1; }

ROOT="${COMMANDER_RUNTIME_ROOT:-}"
if [[ -z "$ROOT" ]]; then
  for candidate in "$HOME/commander-runtime" "$HOME/commander-workspaces/chatgpt-autopilot"; do
    if [[ -f "$candidate/src/integrations/mcp/commander/remote-service.mjs" ]]; then ROOT="$candidate"; break; fi
  done
fi
[[ -n "$ROOT" ]] || { echo "Commander runtime not found" >&2; exit 1; }

NODE_BIN="$(readlink -f "$(command -v node)")"
CONTROL_SOCKET="$XDG_RUNTIME_DIR/chatgpt-autopilot-commander/gateway.sock"
[[ -S "$CONTROL_SOCKET" ]] || { echo "Primary Commander control socket missing" >&2; exit 1; }

UNIT_DIR="$HOME/commander-workspaces/.commander-systemd"
UNIT="$UNIT_DIR/commander-remote-mcp-primary.service"
mkdir -p "$UNIT_DIR"
chmod 700 "$UNIT_DIR"
cat > "$UNIT" <<UNITFILE
[Unit]
Description=Primary Commander Remote MCP over Tailscale
After=network-online.target chatgpt-autopilot-commander-gateway.service
Wants=network-online.target
Requires=chatgpt-autopilot-commander-gateway.service

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=COMMANDER_REMOTE_MCP_ENABLED=true
Environment=COMMANDER_REMOTE_MCP_PRIVATE_BIND_ENABLED=true
Environment=COMMANDER_REMOTE_MCP_HOST=$TAIL_IP
Environment=COMMANDER_REMOTE_MCP_PORT=8792
Environment=COMMANDER_REMOTE_MCP_MULTI_DEVICE_ENABLED=true
Environment=COMMANDER_REMOTE_MCP_DEVICE_ID=
Environment=COMMANDER_REMOTE_MCP_TOKEN_FILE=$TOKEN_FILE
Environment=COMMANDER_CONTROL_SOCKET=$CONTROL_SOCKET
Environment=XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR
$PEER_ENV_LINE
ExecStart=$NODE_BIN $ROOT/src/integrations/mcp/commander/remote-service.mjs
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadOnlyPaths=$TOKEN_FILE
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
MemoryMax=192M
TasksMax=32

[Install]
WantedBy=default.target
UNITFILE
chmod 600 "$UNIT"

systemctl --user link "$UNIT" >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable --now commander-remote-mcp-primary.service
systemctl --user restart commander-remote-mcp-primary.service

for _ in {1..30}; do
  if curl --fail --silent --show-error --max-time 2 "http://$TAIL_IP:8792/healthz" >/dev/null 2>&1; then
    echo "COMMANDER_REMOTE_MCP_PRIMARY_OK"
    echo "bind=$TAIL_IP:8792"
    echo "service=$(systemctl --user is-active commander-remote-mcp-primary.service)"
    echo "enabled=$(systemctl --user is-enabled commander-remote-mcp-primary.service)"
    echo "peer_auth=${PEER_IP:-bearer-only}"
    exit 0
  fi
  sleep 0.5
done

systemctl --user status commander-remote-mcp-primary.service --no-pager >&2 || true
exit 1
