#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DATA_DIR="${BRIDGE_DATA_DIR:-$HOME/.local/share/browser-bridge}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
case "$OS" in
  Linux*)  PLATFORM=linux; NM_DIR="$HOME/.mozilla/native-messaging-hosts" ;;
  Darwin*) PLATFORM=macos; NM_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
  *) die "Unsupported OS: $OS" ;;
esac

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] && [ -x "/opt/homebrew/bin/node" ]; then
  NODE_BIN="/opt/homebrew/bin/node"
fi
[ -n "$NODE_BIN" ] || die "node >= 18 not found in PATH"

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node >= 18 required, found $("$NODE_BIN" -v)"

chmod +x "$DIR/host/host.js" "$DIR/host/mcp-server.js" "$DIR/host/bridge.js" "$DIR/scripts/sign-xpi.sh"

# Wrapper script with absolute node path so GUI-launched Firefox always finds node
# without mutating tracked files inside the git repository.
mkdir -p "$BRIDGE_DATA_DIR"
LAUNCHER="$BRIDGE_DATA_DIR/run-host.sh"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$DIR/host/host.js" "\$@"
EOF
chmod +x "$LAUNCHER"

mkdir -p "$NM_DIR"
cat > "$NM_DIR/browser_bridge.json" <<EOF
{
  "name": "browser_bridge",
  "description": "browser-bridge native messaging host",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_extensions": [
    "browser-bridge@trytodupe.github.io",
    "browser-bridge@localhost"
  ]
}
EOF
log "Registered Firefox Native Messaging host: $NM_DIR/browser_bridge.json -> $LAUNCHER"

# Wire Antigravity MCP config if ~/.gemini/antigravity exists
AGY_MCP_CONFIG="$HOME/.gemini/antigravity/mcp_config.json"
if [ -f "$AGY_MCP_CONFIG" ]; then
  "$NODE_BIN" - "$AGY_MCP_CONFIG" "$NODE_BIN" "$DIR/host/mcp-server.js" <<'EOF'
const fs = require("fs");
const [cfgPath, nodeBin, mcpPath] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers["browser-bridge"] = {
  command: nodeBin,
  args: [mcpPath]
};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
EOF
  log "Updated Antigravity MCP config: $AGY_MCP_CONFIG"
fi

log "Done. Next steps:"
echo "  1. Build / sign the Firefox addon: ./scripts/sign-xpi.sh"
echo "  2. Install dist/*.xpi in Firefox (or load addon/manifest.json via about:debugging)"
