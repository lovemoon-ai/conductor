#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_NAME="${CONDUCTOR_CLI_PACKAGE_NAME:-@love-moon/conductor-cli}"
NODE_VERSION="${CONDUCTOR_BUNDLED_NODE_VERSION:-23.11.0}"
HOMEBREW_FORMULA="${CONDUCTOR_HOMEBREW_FORMULA:-lovemoon-ai/tap/conductor}"
OUTPUT_DIR="${4:-$ROOT_DIR/cli/dist/release}"

usage() {
  cat <<'EOF'
Usage: build-cli-release.sh <version> <os> <arch> [output_dir]

Examples:
  ./scripts/build-cli-release.sh 0.2.34 darwin arm64
  ./scripts/build-cli-release.sh 0.2.34 linux x64 ./cli/dist/release
EOF
}

log() {
  printf '==> %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

sha256_file() {
  local target="$1"
  local target_name
  target_name="$(basename "$target")"
  if command -v shasum >/dev/null 2>&1; then
    printf '%s  %s\n' "$(shasum -a 256 "$target" | awk '{ print $1 }')" "$target_name"
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "$(sha256sum "$target" | awk '{ print $1 }')" "$target_name"
  else
    printf 'Missing sha256 tool (expected shasum or sha256sum)\n' >&2
    exit 1
  fi
}

download_file() {
  local url="$1"
  local destination="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$destination"
  else
    printf 'Missing download tool (expected curl or wget)\n' >&2
    exit 1
  fi
}

if [[ $# -lt 3 || $# -gt 4 ]]; then
  usage >&2
  exit 1
fi

VERSION="$1"
TARGET_OS="$2"
TARGET_ARCH="$3"
PACKAGE_SPEC="${CONDUCTOR_CLI_PACKAGE_SPEC:-${PACKAGE_NAME}@${VERSION}}"

case "$TARGET_OS" in
  darwin|linux)
    ;;
  *)
    printf 'Unsupported OS: %s\n' "$TARGET_OS" >&2
    exit 1
    ;;
esac

case "$TARGET_ARCH" in
  x64|arm64)
    ;;
  *)
    printf 'Unsupported arch: %s\n' "$TARGET_ARCH" >&2
    exit 1
    ;;
esac

require_command npm
require_command tar
require_command mktemp

ARCHIVE_STEM="conductor-v${VERSION}-${TARGET_OS}-${TARGET_ARCH}"
BUILD_ROOT="$ROOT_DIR/cli/dist/release-build/${ARCHIVE_STEM}"
STAGE_ROOT="$BUILD_ROOT/${ARCHIVE_STEM}"
PACKAGE_BUNDLE_ROOT="$STAGE_ROOT/libexec/package"
PACKAGE_ROOT="$PACKAGE_BUNDLE_ROOT/node_modules/${PACKAGE_NAME}"
ARCHIVE_PATH="$OUTPUT_DIR/${ARCHIVE_STEM}.tar.gz"
CHECKSUM_PATH="${ARCHIVE_PATH}.sha256"
NODE_ARCHIVE_NAME="node-v${NODE_VERSION}-${TARGET_OS}-${TARGET_ARCH}.tar.gz"
NODE_DOWNLOAD_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE_NAME}"
TEMP_NODE_ARCHIVE="$(mktemp -t "${ARCHIVE_STEM}.XXXXXX")"
SYMLINK_SMOKE_DIR="$(mktemp -d -t "${ARCHIVE_STEM}.symlink.XXXXXX")"

cleanup() {
  rm -f "$TEMP_NODE_ARCHIVE"
  rm -rf "$SYMLINK_SMOKE_DIR"
}
trap cleanup EXIT

rm -rf "$BUILD_ROOT"
mkdir -p "$PACKAGE_BUNDLE_ROOT" "$STAGE_ROOT/bin" "$OUTPUT_DIR"

log "Installing ${PACKAGE_SPEC}"
npm install \
  --prefix "$PACKAGE_BUNDLE_ROOT" \
  --include=optional \
  --omit=dev \
  --no-audit \
  --no-fund \
  "$PACKAGE_SPEC"

if [[ ! -d "$PACKAGE_ROOT" ]]; then
  printf 'Installed package directory not found: %s\n' "$PACKAGE_ROOT" >&2
  exit 1
fi

printf 'homebrew\n' > "${PACKAGE_ROOT}/.install-method"
rm -f "${PACKAGE_BUNDLE_ROOT}/package-lock.json"

log "Downloading bundled Node.js runtime ${NODE_VERSION}"
download_file "$NODE_DOWNLOAD_URL" "$TEMP_NODE_ARCHIVE"

log "Extracting bundled Node.js runtime"
tar -xzf "$TEMP_NODE_ARCHIVE" -C "$BUILD_ROOT"
mv "$BUILD_ROOT/node-v${NODE_VERSION}-${TARGET_OS}-${TARGET_ARCH}" "$STAGE_ROOT/libexec/node"

log "Writing conductor launcher"
cat > "$STAGE_ROOT/bin/conductor" <<EOF
#!/usr/bin/env bash
set -euo pipefail
SOURCE="\${BASH_SOURCE[0]}"
while [[ -h "\$SOURCE" ]]; do
  DIR="\$(cd -P -- "\$(dirname -- "\$SOURCE")" && pwd)"
  TARGET="\$(readlink "\$SOURCE")"
  if [[ "\$TARGET" == /* ]]; then
    SOURCE="\$TARGET"
  else
    SOURCE="\$DIR/\$TARGET"
  fi
done
HERE="\$(cd -P -- "\$(dirname -- "\$SOURCE")" && pwd)"
export CONDUCTOR_INSTALL_METHOD="homebrew"
export CONDUCTOR_HOMEBREW_FORMULA="${HOMEBREW_FORMULA}"
exec "\$HERE/../libexec/node/bin/node" "\$HERE/../libexec/package/node_modules/${PACKAGE_NAME}/bin/conductor.js" "\$@"
EOF
chmod 755 "$STAGE_ROOT/bin/conductor"

log "Running smoke tests"
"$STAGE_ROOT/bin/conductor" --version >/dev/null
ln -s "$STAGE_ROOT/bin/conductor" "$SYMLINK_SMOKE_DIR/conductor"
"$SYMLINK_SMOKE_DIR/conductor" --version >/dev/null
"$STAGE_ROOT/libexec/node/bin/node" \
  "$PACKAGE_ROOT/bin/conductor-verify-node-pty.js" \
  "$PACKAGE_BUNDLE_ROOT" >/dev/null

log "Creating ${ARCHIVE_PATH}"
tar -C "$BUILD_ROOT" -czf "$ARCHIVE_PATH" "$ARCHIVE_STEM"
sha256_file "$ARCHIVE_PATH" > "$CHECKSUM_PATH"

log "Created archive:"
printf '  %s\n' "$ARCHIVE_PATH"
printf '  %s\n' "$CHECKSUM_PATH"
