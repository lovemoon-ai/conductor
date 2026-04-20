#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
FORMULA_PATH="${2:-$ROOT_DIR/cli/Formula/conductor.rb}"
RELEASE_REPO="${3:-lovemoon-ai/conductor}"
RELEASE_DIR="${RELEASE_DIR:-$ROOT_DIR/cli/dist/release}"
TEMPLATE_PATH="${CONDUCTOR_HOMEBREW_FORMULA_TEMPLATE:-$ROOT_DIR/cli/Formula/conductor.rb.template}"

usage() {
  cat <<'EOF'
Usage: render-homebrew-formula.sh <version> [formula_path] [release_repo]

Reads checksum files from cli/dist/release and renders cli/Formula/conductor.rb
from cli/Formula/conductor.rb.template.

Expected files:
  cli/dist/release/conductor-v<version>-darwin-arm64.tar.gz.sha256
  cli/dist/release/conductor-v<version>-darwin-x64.tar.gz.sha256
  cli/dist/release/conductor-v<version>-linux-arm64.tar.gz.sha256
  cli/dist/release/conductor-v<version>-linux-x64.tar.gz.sha256
EOF
}

if [[ $# -lt 1 || $# -gt 3 ]]; then
  usage >&2
  exit 1
fi

VERSION="$1"

if [[ ! -f "$TEMPLATE_PATH" ]]; then
  printf 'Missing formula template: %s\n' "$TEMPLATE_PATH" >&2
  exit 1
fi

read_sha() {
  local target_os="$1"
  local target_arch="$2"
  local checksum_file="$RELEASE_DIR/conductor-v${VERSION}-${target_os}-${target_arch}.tar.gz.sha256"
  if [[ ! -f "$checksum_file" ]]; then
    printf 'Missing checksum file: %s\n' "$checksum_file" >&2
    exit 1
  fi
  awk '{ print $1 }' "$checksum_file"
}

DARWIN_ARM64_SHA="$(read_sha darwin arm64)"
DARWIN_X64_SHA="$(read_sha darwin x64)"
LINUX_ARM64_SHA="$(read_sha linux arm64)"
LINUX_X64_SHA="$(read_sha linux x64)"

mkdir -p "$(dirname "$FORMULA_PATH")"

formula="$(< "$TEMPLATE_PATH")"
formula="${formula//__VERSION__/$VERSION}"
formula="${formula//__RELEASE_REPO__/$RELEASE_REPO}"
formula="${formula//__SHA256_DARWIN_ARM64__/$DARWIN_ARM64_SHA}"
formula="${formula//__SHA256_DARWIN_X64__/$DARWIN_X64_SHA}"
formula="${formula//__SHA256_LINUX_ARM64__/$LINUX_ARM64_SHA}"
formula="${formula//__SHA256_LINUX_X64__/$LINUX_X64_SHA}"

if [[ "$formula" == *"__"* ]]; then
  printf 'Rendered formula still contains placeholders\n' >&2
  exit 1
fi

printf '%s\n' "$formula" > "$FORMULA_PATH"

printf 'Rendered %s\n' "$FORMULA_PATH"
