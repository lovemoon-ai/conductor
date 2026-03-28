#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

remove_global_package() {
  local package_name="$1"
  pnpm remove -g "$package_name" >/dev/null 2>&1 || true
}

echo "==> Building local SDK packages"
pnpm -C "$ROOT_DIR/modules/ai-sdk" install
pnpm -C "$ROOT_DIR/modules/ai-sdk" run build
pnpm -C "$ROOT_DIR/modules/conductor-sdk" install
pnpm -C "$ROOT_DIR/modules/conductor-sdk" run build

echo "==> Installing CLI dependencies"
pnpm -C "$ROOT_DIR/cli" install

echo "==> Rebuilding native CLI dependencies"
pnpm -C "$ROOT_DIR/cli" rebuild node-pty

echo "==> Refreshing global conductor link"
remove_global_package "@conductor/conductor-fire"
remove_global_package "@love-moon/conductor-cli"
remove_global_package "conductor-claude-code"
(
  cd "$ROOT_DIR/cli"
  pnpm link
)

CONDUCTOR_BIN="$(command -v conductor || true)"
EXPECTED_MARKER="$ROOT_DIR/cli/node_modules"

if [[ -z "$CONDUCTOR_BIN" ]]; then
  echo "conductor binary not found after linking" >&2
  exit 1
fi

if ! grep -Fq "$EXPECTED_MARKER" "$CONDUCTOR_BIN"; then
  echo "global conductor shim does not point to the current repository" >&2
  echo "expected marker: $EXPECTED_MARKER" >&2
  echo "shim path: $CONDUCTOR_BIN" >&2
  sed -n '1,40p' "$CONDUCTOR_BIN" >&2 || true
  exit 1
fi

echo "==> Verifying Claude ai-sdk provider"
pnpm -C "$ROOT_DIR/cli" exec node --input-type=module -e "import { createAiSession } from '@love-moon/ai-sdk'; const session = createAiSession('claude'); await session.readyPromise; const snapshot = session.getSnapshot(); if (snapshot.provider !== 'claude-agent-sdk') { throw new Error(\`Unexpected Claude provider: \${snapshot.provider}\`); } await session.close(); console.log('Verified provider:', snapshot.provider);"

echo "==> Verifying node-pty native binding"
pnpm -C "$ROOT_DIR/cli" exec node "$ROOT_DIR/cli/bin/conductor-verify-node-pty.js" "$ROOT_DIR/cli"

echo "==> Linked conductor"
conductor --version
