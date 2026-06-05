#!/bin/bash
# One-click startup for the Volcengine web service
# Purpose: quickly start or restart the Conductor Web service on the server

set -euo pipefail

REMOTE_DIR="/opt/conductor/conductor"
LOG="/opt/conductor/conductor.log"
cd "$REMOTE_DIR"

env=web/.env.production.local
if [ ! -f $env ]; then
    echo "❌ $env not found. Please copy it first."
    exit 1
fi

echo "🚀 Starting Conductor Web on Volcengine..."

# 0. Pre-deploy guard: warn (do not block) if there are pending changesets.
# Per claw/sop/06_release.md "Release order", combined releases ship more
# cleanly when the npm publish happens first so the freshly-bumped
# cli/package.json shows up on settings without a brief stale-version flash.
# Warning only — sometimes a server-side fix needs to ship before the
# corresponding CLI release, and forcing the order would block that.
if command -v find >/dev/null 2>&1; then
  pending_changesets=$(find .changeset -maxdepth 1 -type f -name '*.md' \
    ! -name 'README.md' 2>/dev/null | head -20 || true)
  if [[ -n "$pending_changesets" ]]; then
    cat <<EOF >&2
⚠️  .changeset/ has unreleased entries:
$(echo "$pending_changesets" | sed 's/^/   /')
   This deploy will pin the OLD cli/package.json version on the web build.
   The runtime /api/cli-version fetch hides this from end users, but for a
   clean combined release the canonical order is:
     1. Merge the auto-opened "version packages" PR
     2. Let release-packages.yml publish npm + dispatch CLI archive
     3. Update lovemoon-ai/homebrew-tap manually
     4. THEN re-run this deploy script
   See claw/sop/06_release.md → "Release order" for the full rationale.
   Continuing in 3 seconds (Ctrl+C to abort)...
EOF
    sleep 3
  fi
fi

# 1. Load the Node environment
if [[ -f /root/.nvm/nvm.sh ]]; then
  source /root/.nvm/nvm.sh
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node not found. Please install Node.js first." >&2
  exit 1
fi

# 2. Make sure dependencies are installed
if [[ ! -d web/node_modules ]]; then
  echo "📦 Installing dependencies..."
  npm --prefix web install
fi

# 3. Refresh the Prisma Client first so the build does not use stale schema types
echo "🔧 Generating Prisma Client..."
npm --prefix web run db:generate

# 3b. Stamp build info so /build-info.json can prove which commit is live
echo "🏷️  Writing build-info.json..."
mkdir -p web/public
COMMIT=$(git -C "$REMOTE_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")
COMMIT_SHORT=$(git -C "$REMOTE_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
WEB_VERSION=$(node -p "require('./web/package.json').version" 2>/dev/null || echo "unknown")
cat > web/public/build-info.json <<EOF
{
  "commit": "$COMMIT",
  "commitShort": "$COMMIT_SHORT",
  "buildTime": "$BUILD_TIME",
  "webVersion": "$WEB_VERSION"
}
EOF
echo "   commit=$COMMIT_SHORT buildTime=$BUILD_TIME"

# 4. Atomic production build: compile into .next.build, validate, then swap.
# The live server keeps reading the old .next until the swap, so mid-build
# requests can't see half-written files. distDir is picked up from
# NEXT_DIST_DIR by next.config.ts.
echo "🔨 Building production bundle (into .next.build)..."
rm -rf web/.next.build
(cd web && NEXT_DIST_DIR=.next.build npx next build)

if [[ ! -f web/.next.build/BUILD_ID ]]; then
  echo "❌ Build did not produce web/.next.build/BUILD_ID; aborting (old .next left untouched)."
  rm -rf web/.next.build
  exit 1
fi

echo "🔁 Swapping .next <- .next.build..."
rm -rf web/.next.old
if [[ -d web/.next ]]; then
  mv web/.next web/.next.old
fi
mv web/.next.build web/.next
rm -rf web/.next.old

# Make sure Nginx can read the static files
chmod -R 755 web/.next

# 5. Configure Nginx
if command -v nginx >/dev/null 2>&1; then
  echo "⚙️  Updating Nginx config..."
  cp web/nginx_conf /etc/nginx/sites-available/conductor
  ln -sf /etc/nginx/sites-available/conductor /etc/nginx/sites-enabled/conductor
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
fi

# 6. Start the web service
echo "🌐 Starting web service..."

# Load environment variables
if [ -f web/.env.production.local ]; then
  export $(grep -v '^#' web/.env.production.local | xargs)
fi

if [ -n "${PORT:-}" ]; then
  echo "🔧 Clearing port $PORT..."
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti tcp:"$PORT" || true)
  elif command -v fuser >/dev/null 2>&1; then
    pids=$(fuser -n tcp "$PORT" 2>/dev/null || true)
  else
    pids=""
  fi
  if [ -n "$pids" ]; then
    echo "Killing process(es) on port $PORT: $pids"
    kill -9 $pids || true
  fi
else
  echo "⚠️ PORT not set; skipping port cleanup."
fi

echo "Using nohup..."
# IMPORTANT: scope the pkill to conductor's own install path so we do
# NOT kill sibling apps on the same box (e.g. operator, which runs its
# own `tsx server.ts` out of /opt/conductor/operator/web/app). Without
# this anchor the regex matches both processes and a conductor deploy
# would take operator offline until its systemd unit restarted.
pkill -f "/opt/conductor/conductor/.*server\.ts" || true
sleep 1
nohup npm --prefix web run start > $LOG 2>&1 &
echo "Started with PID: $!"

# 6. Health check
echo ""
echo "⏳ Waiting for service to start..."
sleep 3

echo ""
echo "🔍 Health Check:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if command -v curl >/dev/null 2>&1; then
  echo "Next.js (6152):"
  curl -I --max-time 5 http://127.0.0.1:6152/api/health 2>/dev/null | head -n 1 || echo "  ❌ Failed"

  echo "Nginx HTTP (80):"
  curl -I --max-time 5 http://127.0.0.1/ 2>/dev/null | head -n 1 || echo "  ❌ Failed"

  echo "Nginx HTTPS (443):"
  curl -k -I --max-time 5 https://127.0.0.1/ 2>/dev/null | head -n 1 || echo "  ❌ Failed"

  # 6b. Real page smoke test: any 200 with a <title>404 body means Next fell
  # back to the global not-found during prerender, i.e. the build is broken
  # even though /api/health is green.
  echo ""
  echo "🔎 Page smoke test:"
  smoke_fail=0
  for path in / /login /app/tasks /app/projects; do
    tmp=$(mktemp)
    code=$(curl -s -o "$tmp" -w '%{http_code}' --max-time 5 "http://127.0.0.1:6152$path")
    size=$(wc -c <"$tmp" | tr -d ' ')
    if [[ "$code" != "200" ]]; then
      echo "  ❌ $path http=$code size=$size"
      smoke_fail=1
    elif grep -q '<title>404' "$tmp"; then
      echo "  ❌ $path rendered 404 page (prerender bailout)"
      smoke_fail=1
    else
      echo "  ✅ $path http=$code size=$size"
    fi
    rm -f "$tmp"
  done

  # Verify build-info.json is actually served so we know what is live.
  build_info=$(curl -s --max-time 5 http://127.0.0.1:6152/build-info.json || true)
  if printf '%s' "$build_info" | grep -q "$COMMIT_SHORT"; then
    echo "  ✅ /build-info.json reports commit=$COMMIT_SHORT"
  else
    echo "  ❌ /build-info.json missing or stale: $build_info"
    smoke_fail=1
  fi

  if [[ "$smoke_fail" == "1" ]]; then
    echo ""
    echo "❌ Smoke test failed — check $LOG and /var/log/nginx/error.log before declaring ship."
    exit 1
  fi
fi

echo ""
echo "✅ Conductor Web is running!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🌍 Public URL: https://conductor-ai.top"
echo "📊 Logs: tail -f $LOG"
echo "📋 Nginx Logs: tail -f /var/log/nginx/error.log"
echo "🔄 Restart: systemctl restart conductor-web"
echo "🛑 Stop: systemctl stop conductor-web"

# 7. Configure the Outbox Processor cron job
echo ""
echo "⏰ Configuring Outbox Processor cron job..."

CRON_COMMENT="# Conductor Outbox Processor - runs once per minute"
CRON_JOB="* * * * * cd $REMOTE_DIR && curl -s -H \"Authorization: Bearer \${CRON_SECRET}\" http://127.0.0.1:6152/api/cron/outbox-processor > /dev/null 2>&1"

# Check whether the cron job already exists
if ! crontab -l 2>/dev/null | grep -q "outbox-processor"; then
  # Make sure CRON_SECRET is available
  if [ -z "${CRON_SECRET:-}" ] && [ -f web/.env.production.local ]; then
    export CRON_SECRET=$(grep -E "^CRON_SECRET=" web/.env.production.local | cut -d'=' -f2 | tr -d '"' || echo "")
  fi

  if [ -n "${CRON_SECRET:-}" ]; then
    # Add the job to crontab
    (crontab -l 2>/dev/null; echo "$CRON_COMMENT"; echo "CRON_SECRET=$CRON_SECRET"; echo "$CRON_JOB") | crontab -
    echo "✅ Cron job added: outbox-processor (every minute)"
  else
    echo "⚠️  CRON_SECRET not set, skipping cron configuration"
    echo "   Add CRON_SECRET to web/.env.production.local and run:"
    echo "   (crontab -l; echo \"* * * * * cd $REMOTE_DIR && curl -H \\\"Authorization: Bearer <SECRET>\\\" http://127.0.0.1:6152/api/cron/outbox-processor\") | crontab -"
  fi
else
  echo "✅ Cron job already exists: outbox-processor"
fi

# Show the current crontab
echo ""
echo "📋 Current Crontab:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
crontab -l 2>/dev/null | grep -A2 "Conductor Outbox" || echo "  (No Conductor cron jobs found)"
echo ""
echo "✅ All done!"
