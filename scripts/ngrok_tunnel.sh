#!/usr/bin/env bash
set -euo pipefail

# Simple helper to expose local HTTP backend over public HTTPS via ngrok
# Usage: bash scripts/ngrok_tunnel.sh [port]

PORT="${1:-6152}"
UPSTREAM_HOST="${UPSTREAM_HOST:-localhost}"
NGROK_BIN="${NGROK_BIN:-ngrok}"
LOG_FILE="/tmp/ngrok_${PORT}.log"
PID_FILE="/tmp/ngrok_${PORT}.pid"

have_cmd() { command -v "$1" >/dev/null 2>&1; }
curl_local() {
  env \
    -u http_proxy \
    -u https_proxy \
    -u HTTP_PROXY \
    -u HTTPS_PROXY \
    -u ALL_PROXY \
    -u all_proxy \
    NO_PROXY="127.0.0.1,localhost" \
    no_proxy="127.0.0.1,localhost" \
    curl --noproxy '*' "$@"
}

run_ngrok() {
  env \
    -u http_proxy \
    -u https_proxy \
    -u HTTP_PROXY \
    -u HTTPS_PROXY \
    -u ALL_PROXY \
    -u all_proxy \
    NO_PROXY="127.0.0.1,localhost" \
    no_proxy="127.0.0.1,localhost" \
    "$NGROK_BIN" "$@"
}

stop_existing_tunnel() {
  local pids=""

  if [ -f "$PID_FILE" ]; then
    pids="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi

  if [ -z "$pids" ]; then
    pids="$(pgrep -f "ngrok http .*:${PORT}" || true)"
  fi

  if [ -z "$pids" ]; then
    return 0
  fi

  echo "Stopping existing ngrok tunnel(s) for :${PORT} ..."
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done

  for _ in $(seq 1 20); do
    if ! pgrep -f "ngrok http .*:${PORT}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done

  for pid in $pids; do
    kill -9 "$pid" 2>/dev/null || true
  done

  rm -f "$PID_FILE"
}

if ! have_cmd "$NGROK_BIN"; then
  echo "ngrok not found. Install with:"
  echo "  brew install ngrok/ngrok/ngrok  # macOS" >&2
  echo "Or download from https://ngrok.com/download" >&2
  exit 1
fi

# Optional: configure authtoken if provided
if [ -n "${NGROK_AUTHTOKEN:-}" ]; then
  run_ngrok config add-authtoken "$NGROK_AUTHTOKEN" >/dev/null 2>&1 || true
fi

if pgrep -f "ngrok http .*:${PORT}" >/dev/null 2>&1 || [ -f "$PID_FILE" ]; then
  stop_existing_tunnel
fi

echo "Starting ngrok tunnel -> http://${UPSTREAM_HOST}:${PORT} ..."
nohup bash -lc "$(printf '%q ' env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost "$NGROK_BIN" http --log=stdout --log-level=info "http://${UPSTREAM_HOST}:${PORT}")" > "$LOG_FILE" 2>&1 &
NGROK_PID=$!
echo "$NGROK_PID" > "$PID_FILE"

# Wait for local API (4040) and extract the HTTPS public URL
ATTEMPTS=0
PUB_URL=""
until [ $ATTEMPTS -gt 60 ]; do
  if curl_local -fsS "http://127.0.0.1:4040/api/tunnels" >/dev/null 2>&1; then
    PUB_URL=$(curl_local -fsS "http://127.0.0.1:4040/api/tunnels" | \
      python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    for t in d.get("tunnels", []):
        url=t.get("public_url", "")
        if url.startswith("https://"):
            print(url)
            break
except Exception:
    pass'
    )
    if [ -n "$PUB_URL" ]; then
      break
    fi
  fi
  ATTEMPTS=$((ATTEMPTS+1))
  sleep 0.5
done

if [ -z "$PUB_URL" ]; then
  echo "Failed to discover ngrok public URL. Check logs: $LOG_FILE" >&2
  exit 2
fi

WS_URL=$(python3 -c 'from urllib.parse import urlparse, urlunparse
import sys
u=sys.argv[1]
pu=urlparse(u)
scheme="wss"
path="/ws/app"
print(urlunparse((scheme, pu.netloc, path, "", "", "")))' \
  "$PUB_URL")

echo "NGROK_HTTPS_URL=$PUB_URL"
echo "NGROK_WSS_URL=$WS_URL"
