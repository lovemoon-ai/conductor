#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_PATH="$ROOT_DIR/.env"
if [[ -f "$ENV_PATH" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_PATH"
  set +a
fi

if [[ -n "${DB_URL:-}" ]]; then
  IFS='|' read -r DB_USERNAME DB_PASSWORD DB_HOST DB_PORT DB_NAME < <(
    python3 - <<'PY'
import os
from urllib.parse import urlparse

url = os.environ.get("DB_URL", "")
parsed = urlparse(url)
parts = [
    parsed.username or "",
    parsed.password or "",
    parsed.hostname or "",
    str(parsed.port or ""),
    (parsed.path or "").lstrip("/"),
]
print("|".join(parts))
PY
  )
fi

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_USERNAME="${DB_USERNAME:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-postgres}"
DB_NAME="${DB_NAME:-conductor}"
POSTGRES_SUPERUSER="${POSTGRES_SUPERUSER:-postgres}"

if [[ "$DB_HOST" != "127.0.0.1" && "$DB_HOST" != "localhost" ]]; then
  echo "DB_URL points to remote host (${DB_HOST}); skipping local Postgres start."
  exit 0
fi

if [[ "$DB_PORT" != "5432" ]]; then
  echo "Warning: DB_PORT=$DB_PORT; system Postgres usually listens on 5432." >&2
  echo "If you need a custom port, update PostgreSQL config manually." >&2
fi

OS_NAME="$(uname -s)"
SERVICE_NAME=""

if [[ "$OS_NAME" == "Darwin" ]]; then
  if [[ -d "/opt/homebrew/opt/postgresql@15/bin" ]]; then
    PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
  elif [[ -d "/usr/local/opt/postgresql@15/bin" ]]; then
    PATH="/usr/local/opt/postgresql@15/bin:$PATH"
  fi
fi

install_postgres_macos() {
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew not found; install it first: https://brew.sh" >&2
    exit 1
  fi
  if ! brew list postgresql@15 >/dev/null 2>&1; then
    brew install postgresql@15
  fi
  SERVICE_NAME="postgresql@15"
}

install_postgres_linux() {
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y postgresql
    SERVICE_NAME="postgresql"
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y postgresql-server
    SERVICE_NAME="postgresql"
    if [[ ! -f /var/lib/pgsql/data/PG_VERSION ]] && command -v postgresql-setup >/dev/null 2>&1; then
      sudo postgresql-setup --initdb
    fi
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y postgresql-server
    SERVICE_NAME="postgresql"
    if [[ ! -f /var/lib/pgsql/data/PG_VERSION ]] && command -v postgresql-setup >/dev/null 2>&1; then
      sudo postgresql-setup --initdb
    fi
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm postgresql
    SERVICE_NAME="postgresql"
    if [[ ! -f /var/lib/postgres/data/PG_VERSION ]]; then
      sudo -iu postgres initdb --locale=C -D /var/lib/postgres/data
    fi
  else
    echo "Unsupported Linux distro: install PostgreSQL manually." >&2
    exit 1
  fi
}

start_service_macos() {
  brew services stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  brew services start "$SERVICE_NAME"
}

start_service_linux() {
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    sudo systemctl start "$SERVICE_NAME"
  elif command -v service >/dev/null 2>&1; then
    sudo service "$SERVICE_NAME" stop >/dev/null 2>&1 || true
    sudo service "$SERVICE_NAME" start
  else
    pkill -f postgres >/dev/null 2>&1 || true
    if command -v pg_ctl >/dev/null 2>&1; then
      pg_ctl start -D /var/lib/postgres/data
    else
      echo "Cannot start Postgres service; install systemctl/service or use pg_ctl." >&2
      exit 1
    fi
  fi
}

ensure_install() {
  if command -v psql >/dev/null 2>&1; then
    return 0
  fi
  case "$OS_NAME" in
    Darwin) install_postgres_macos ;;
    Linux) install_postgres_linux ;;
    *) echo "Unsupported OS: $OS_NAME" >&2; exit 1 ;;
  esac
}

wait_for_ready() {
  for _ in {1..30}; do
    if pg_isready -h "$DB_HOST" -p "$DB_PORT" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

run_psql() {
  local sql="$1"
  if id postgres >/dev/null 2>&1; then
    if sudo -n true >/dev/null 2>&1; then
      sudo -u postgres psql -d postgres -tAc "$sql"
      return
    fi
  fi
  psql -d postgres -tAc "$sql"
}

ensure_install

if [[ "$OS_NAME" == "Darwin" && -z "$SERVICE_NAME" ]]; then
  if brew list postgresql@15 >/dev/null 2>&1; then
    SERVICE_NAME="postgresql@15"
  else
    echo "PostgreSQL is installed but service name is unknown." >&2
    exit 1
  fi
fi

if pg_isready -h "$DB_HOST" -p "$DB_PORT" >/dev/null 2>&1; then
  echo "Postgres already running; skip"
  exit
fi

case "$OS_NAME" in
  Darwin) start_service_macos ;;
  Linux) start_service_linux ;;
  *) echo "Unsupported OS: $OS_NAME" >&2; exit 1 ;;
esac

if ! wait_for_ready; then
  echo "Postgres failed to start on ${DB_HOST}:${DB_PORT}" >&2
  exit 1
fi

if ! run_psql "SELECT 1" >/dev/null 2>&1; then
  echo "psql connection failed; ensure you can connect as a superuser." >&2
  exit 1
fi

ROLE_EXISTS="$(run_psql "SELECT 1 FROM pg_roles WHERE rolname='${DB_USERNAME}'" | tr -d '[:space:]')"
if [[ "$ROLE_EXISTS" != "1" ]]; then
  run_psql "CREATE ROLE \"${DB_USERNAME}\" LOGIN PASSWORD '${DB_PASSWORD}';"
fi

DB_EXISTS="$(run_psql "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | tr -d '[:space:]')"
if [[ "$DB_EXISTS" != "1" ]]; then
  run_psql "CREATE DATABASE \"${DB_NAME}\" OWNER \"${DB_USERNAME}\";"
fi

echo "Postgres is running and configured for ${DB_USERNAME}@${DB_NAME} (${DB_HOST}:${DB_PORT})."
