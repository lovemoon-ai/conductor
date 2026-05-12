#!/usr/bin/env bash
# Gate 4: no changeset markdown is allowed to instruct operators to run
# `prisma db push` / `pnpm ... db:push`. Production deploys use
# `prisma migrate deploy`, and shipping `db push` advice in a public
# CHANGELOG entry is exactly how 0.3.0 left volc with two undocumented
# columns (lesson: arch_release-packages-pnpm-changesets-20260512.md).
#
# Usage:
#   .../check-changeset-no-db-push.sh --staged
#       Scan only the changeset markdown files currently staged for commit.
#       Used by .githooks/pre-commit.
#
#   .../check-changeset-no-db-push.sh --range <base>..<head>
#       Scan every changeset markdown file added or modified between base
#       and head. Used by .githooks/pre-push.

set -euo pipefail

usage() {
  echo "usage: $0 --staged | --range <base>..<head>" >&2
  exit 2
}

mode=""
range=""
case "${1:-}" in
  --staged) mode="staged" ;;
  --range)
    mode="range"
    range="${2:-}"
    [[ -n "$range" ]] || usage
    ;;
  *) usage ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Enumerate the changeset markdown files in scope. README.md is template-only;
# never scan it.
if [[ "$mode" == "staged" ]]; then
  touched=$(git diff --cached --name-only --diff-filter=AM -- '.changeset/*.md' \
    | grep -vE '^\.changeset/README\.md$' || true)
else
  touched=$(git diff --name-only --diff-filter=AM "$range" -- '.changeset/*.md' \
    | grep -vE '^\.changeset/README\.md$' || true)
fi

if [[ -z "$touched" ]]; then
  echo "[gate-4] no changeset files touched, skipping."
  exit 0
fi

bad_files=""
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  # Match: `db push`, `db:push`, `prisma db push`, `pnpm ... db:push`, etc.
  # Case-insensitive ERE.
  if grep -iEn 'db[:[:space:]]+push|prisma[[:space:]]+db[[:space:]]+push' "$f" >/dev/null; then
    echo "::error file=$f::Changeset references 'db push'."
    grep -niE 'db[:[:space:]]+push|prisma[[:space:]]+db[[:space:]]+push' "$f" | sed "s|^|  $f:|"
    bad_files="$bad_files $f"
  fi
done <<< "$touched"

if [[ -n "$bad_files" ]]; then
  echo
  echo "[gate-4] FAILED: a changeset tells operators to run 'db push'."
  echo "  Production deploys use 'prisma migrate deploy'. Generate a proper"
  echo "  migration and remove the 'db push' line from the changeset:"
  echo "    cd web && npx prisma migrate dev --name <descriptive-name>"
  echo "  See claw/lessons/arch_release-packages-pnpm-changesets-20260512.md"
  exit 1
fi

echo "[gate-4] OK ($(echo "$touched" | wc -l | tr -d ' ') changeset(s) clean)."
