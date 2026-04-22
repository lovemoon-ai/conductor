#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_BIN="$ROOT_DIR/bin/conductor-dev"

remove_global_package() {
  local package_name="$1"
  pnpm remove -g "$package_name" >/dev/null 2>&1 || true
}

echo "==> Removing local dev shim"
rm -f "$DEV_BIN"

echo "==> Cleaning legacy global links (if present)"
remove_global_package "@love-moon/conductor-cli"
remove_global_package "@conductor/conductor-fire"
remove_global_package "conductor-claude-code"

echo "Done. The system-installed conductor (brew / public install.sh) is untouched; uninstall that separately with 'brew uninstall conductor' if needed."
