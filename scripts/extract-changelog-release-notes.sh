#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CHANGELOG_PATH="${CHANGELOG_PATH:-$ROOT_DIR/CHANGELOG.md}"

usage() {
  cat <<'EOF'
Usage: extract-changelog-release-notes.sh <version> [output_path]

Extracts the changelog section for <version> from CHANGELOG_PATH and writes
the release notes. The version may be passed as 1.2.3 or v1.2.3.
EOF
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage >&2
  exit 1
fi

VERSION="${1#v}"
OUTPUT_PATH="${2:-}"

if [[ ! -f "$CHANGELOG_PATH" ]]; then
  printf 'Missing changelog: %s\n' "$CHANGELOG_PATH" >&2
  exit 1
fi

if ! notes="$(
  awk -v version="$VERSION" '
    function trim(s) {
      gsub(/^[[:space:]]+/, "", s)
      gsub(/[[:space:]]+$/, "", s)
      return s
    }

    function heading_version(line, s) {
      s = line
      sub(/^##[[:space:]]+/, "", s)
      sub(/[[:space:]]+-.*$/, "", s)
      s = trim(s)
      if (s ~ /^\[[^]]+\]$/) {
        sub(/^\[/, "", s)
        sub(/\]$/, "", s)
      }
      sub(/^v/, "", s)
      return s
    }

    $0 ~ /^##[[:space:]]+/ {
      if (found) {
        exit 0
      }
      if (heading_version($0) == version) {
        found = 1
        next
      }
    }

    found {
      print
    }

    END {
      if (!found) {
        exit 2
      }
    }
  ' "$CHANGELOG_PATH"
)"; then
  printf '%s does not contain a release section for version %s\n' "$CHANGELOG_PATH" "$VERSION" >&2
  exit 1
fi

notes="$(
  printf '%s\n' "$notes" | awk '
    NF {
      seen = 1
    }
    seen {
      lines[++count] = $0
    }
    END {
      while (count > 0 && lines[count] ~ /^[[:space:]]*$/) {
        count--
      }
      for (i = 1; i <= count; i++) {
        print lines[i]
      }
    }
  '
)"

if [[ -z "$(printf '%s' "$notes" | tr -d '[:space:]')" ]]; then
  printf '%s release section for version %s is empty\n' "$CHANGELOG_PATH" "$VERSION" >&2
  exit 1
fi

if [[ -n "$OUTPUT_PATH" ]]; then
  mkdir -p "$(dirname "$OUTPUT_PATH")"
  printf '%s\n' "$notes" > "$OUTPUT_PATH"
  printf 'Extracted release notes to %s\n' "$OUTPUT_PATH"
else
  printf '%s\n' "$notes"
fi
