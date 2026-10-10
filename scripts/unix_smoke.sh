#!/usr/bin/env bash
# Smoke-check ScriptCraft Studio on Linux / macOS (no Windows installer features).
# Usage from the studio root: ./scripts/unix_smoke.sh
# Needs Node.js 22+ and npm. Optional: python3, pwsh.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is required" >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "[ERROR] Node.js 22+ required (have $(node -v))" >&2
  exit 1
fi

echo "[1/3] npm install (if needed)"
if [ ! -d node_modules ]; then
  npm install --legacy-peer-deps --no-audit --no-fund
fi

echo "[2/3] npm test"
npm test

echo "[3/3] start_studio.sh nowindow (health check, then stop)"
export PORT="${PORT:-3011}"
./start_studio.sh nowindow &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

ready=0
i=0
while [ "$i" -lt 120 ]; do
  i=$((i + 1))
  if node -e "fetch('http://127.0.0.1:${PORT}/api/health').then(async r=>{const d=await r.json(); if(!r.ok) process.exit(1); if(d.platform==='win32') process.exit(2); process.exit(0)},()=>process.exit(1))" 2>/dev/null; then
    ready=1
    break
  fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "[ERROR] studio did not become healthy on PORT=${PORT}" >&2
  exit 1
fi
echo "[OK] unix smoke passed (server up; /api/health.platform is not win32)"
