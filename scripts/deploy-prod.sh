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

# 4. Force a fresh production build every time instead of reusing an old .next artifact
echo "🔨 Building production bundle..."
npm --prefix web run build

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
pkill -f "tsx server.ts" || true
pkill -f "web/server.ts" || true
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
