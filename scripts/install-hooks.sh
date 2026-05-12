#!/usr/bin/env bash
# Wire this repo's git hooks to .githooks/. Idempotent.
#
# Each contributor should run `./scripts/install-hooks.sh` once after
# cloning. The same gates are also enforced server-side by
# .github/workflows/pr-checks.yml, so missing this step still gets
# caught before merge — but local feedback is much faster.
#
# Run `./scripts/install-hooks.sh --uninstall` to clear the setting.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

case "${1:-}" in
  --uninstall|uninstall)
    if git config --get core.hooksPath >/dev/null 2>&1; then
      git config --unset core.hooksPath
      echo "Cleared core.hooksPath. Git now uses .git/hooks/ as default."
    else
      echo "core.hooksPath is not set; nothing to do."
    fi
    exit 0
    ;;
  -h|--help|help)
    cat <<EOF
Usage: scripts/install-hooks.sh           # enable repo hooks
       scripts/install-hooks.sh --uninstall   # disable repo hooks

This wires \`core.hooksPath\` to .githooks/ so the four pre-merge gates
from the 0.3.0 retro run locally. See .githooks/README.md for what each
hook checks and how to bypass in an emergency.
EOF
    exit 0
    ;;
esac

if [[ ! -d .githooks ]]; then
  echo "error: .githooks/ does not exist at $REPO_ROOT — is this a fresh checkout?" >&2
  exit 1
fi

git config core.hooksPath .githooks

echo "git core.hooksPath = $(git config --get core.hooksPath)"
echo "Active hooks:"
find .githooks -maxdepth 1 -type f -perm -u+x \
  ! -name 'README*' \
  -print 2>/dev/null \
  | sed 's|^.githooks/|  |' \
  | sort
