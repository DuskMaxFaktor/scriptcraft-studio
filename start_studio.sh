#!/usr/bin/env bash
# ScriptCraft Studio on Linux / macOS: starts the server (installs packages and builds the interface the first
# time) and opens the studio window (Electron) or the browser.
# Usage: ./start_studio.sh [nowindow]      Port: PORT=3000 by default.
# Needs Node.js 22+; Python programs need python3. A runtime/ folder (node, python) next to it is used first.
set -euo pipefail
cd "$(dirname "$0")"

[ -x runtime/node/bin/node ] && export PATH="$PWD/runtime/node/bin:$PATH"
[ -x runtime/python/bin/python3 ] && export PATH="$PWD/runtime/python/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed. Get version 22 or newer: https://nodejs.org" >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "[ERROR] Node.js $(node -v) is too old: version 22 or newer is needed" >&2
  exit 1
fi
command -v python3 >/dev/null 2>&1 || echo "[WARN] python3 not found: Python programs will not run"
[ -f .env ] || { [ -f .env.example ] && cp .env.example .env; } || true

export PORT="${PORT:-3000}"
URL="http://localhost:$PORT"

node scripts/launch.mjs &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true' EXIT INT TERM

# Wait for the server (the first start installs packages and builds the interface: give it time)
# Portable loop: `seq` is missing on some minimal macOS / Alpine images
ready=0
i=0
while [ "$i" -lt 600 ]; do
  i=$((i + 1))
  if node -e "fetch('$URL/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then ready=1; break; fi
  kill -0 "$SERVER" 2>/dev/null || break
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "[ERROR] The studio did not start on $URL" >&2
  exit 1
fi
echo "[OK] ScriptCraft Studio: $URL"

if [ "${1:-}" != "nowindow" ]; then
  case "$(uname -s)" in
    Darwin) ELECTRON="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ;;
    *) ELECTRON="node_modules/electron/dist/electron" ;;
  esac
  if [ -x "$ELECTRON" ]; then
    env -u ELECTRON_RUN_AS_NODE "$ELECTRON" electron/main.cjs --url="$URL" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then
    open "$URL"
  else
    echo "Open $URL in a browser."
  fi
fi

echo "Press Ctrl+C to stop the studio."
wait "$SERVER"
