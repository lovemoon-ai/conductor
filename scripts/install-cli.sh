#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_BIN_DIR="$ROOT_DIR/bin"
DEV_BIN="$DEV_BIN_DIR/conductor-dev"

echo "==> Building local SDK packages"
pnpm -C "$ROOT_DIR/modules/ai-sdk" install
pnpm -C "$ROOT_DIR/modules/ai-sdk" run build
pnpm -C "$ROOT_DIR/modules/conductor-sdk" install
pnpm -C "$ROOT_DIR/modules/conductor-sdk" run build

echo "==> Installing CLI dependencies"
pnpm -C "$ROOT_DIR/cli" install

echo "==> Rebuilding native CLI dependencies"
pnpm -C "$ROOT_DIR/cli" rebuild node-pty

echo "==> Writing local dev shim: $DEV_BIN"
mkdir -p "$DEV_BIN_DIR"
cat >"$DEV_BIN" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
SHIM_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SHIM_DIR/.." && pwd)"
exec node "$REPO_ROOT/cli/bin/conductor.js" "$@"
SHIM
chmod +x "$DEV_BIN"

echo "==> Verifying Claude ai-sdk provider"
pnpm -C "$ROOT_DIR/cli" exec node --input-type=module -e "import { createAiSession } from '@love-moon/ai-sdk'; const session = createAiSession('claude'); await session.readyPromise; const snapshot = session.getSnapshot(); if (snapshot.provider !== 'claude-agent-sdk') { throw new Error(\`Unexpected Claude provider: \${snapshot.provider}\`); } await session.close(); console.log('Verified provider:', snapshot.provider);"

echo "==> Verifying node-pty native binding"
pnpm -C "$ROOT_DIR/cli" exec node "$ROOT_DIR/cli/bin/conductor-verify-node-pty.js" "$ROOT_DIR/cli"

echo "==> Dev binary ready: $DEV_BIN"
"$DEV_BIN" --version
echo "==> Invoke via $DEV_BIN (not installed to system PATH; the system 'conductor' still comes from brew or the public install.sh)"
