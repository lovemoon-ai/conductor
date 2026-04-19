#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
FORMULA_PATH="${2:-$ROOT_DIR/cli/Formula/conductor.rb}"
RELEASE_REPO="${3:-lovemoon-ai/conductor}"
RELEASE_DIR="${RELEASE_DIR:-$ROOT_DIR/cli/dist/release}"

usage() {
  cat <<'EOF'
Usage: render-homebrew-formula.sh <version> [formula_path] [release_repo]

Reads checksum files from cli/dist/release and renders cli/Formula/conductor.rb.

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

cat > "$FORMULA_PATH" <<EOF
class Conductor < Formula
  desc "Run the Conductor CLI and daemon with bundled Node.js runtime"
  homepage "https://conductor-ai.top/"
  version "${VERSION}"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/${RELEASE_REPO}/releases/download/v#{version}/conductor-v#{version}-darwin-arm64.tar.gz"
      sha256 "${DARWIN_ARM64_SHA}"
    else
      url "https://github.com/${RELEASE_REPO}/releases/download/v#{version}/conductor-v#{version}-darwin-x64.tar.gz"
      sha256 "${DARWIN_X64_SHA}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/${RELEASE_REPO}/releases/download/v#{version}/conductor-v#{version}-linux-arm64.tar.gz"
      sha256 "${LINUX_ARM64_SHA}"
    else
      url "https://github.com/${RELEASE_REPO}/releases/download/v#{version}/conductor-v#{version}-linux-x64.tar.gz"
      sha256 "${LINUX_X64_SHA}"
    end
  end

  def install
    bin.install "bin/conductor"
    libexec.install Dir["libexec/*"]
  end

  test do
    assert_match "conductor version", shell_output("#{bin}/conductor --version")
  end
end
EOF

printf 'Rendered %s\n' "$FORMULA_PATH"
