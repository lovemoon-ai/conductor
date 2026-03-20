#!/usr/bin/env bash
set -euo pipefail

remove_global_package() {
  local package_name="$1"
  pnpm remove -g "$package_name" >/dev/null 2>&1 || true
}

remove_global_package "@love-moon/conductor-cli"
remove_global_package "@conductor/conductor-fire"
remove_global_package "conductor-claude-code"

echo "Removed global conductor CLI links"
