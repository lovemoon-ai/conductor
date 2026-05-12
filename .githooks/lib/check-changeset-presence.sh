#!/usr/bin/env bash
# Gate 2: every PR (or branch about to be pushed) that modifies a
# published-package path must include at least one new .changeset/*.md
# file. The 0.3.0 release shipped 20+ commits with no changeset, leaving
# the public CHANGELOG missing every one of them — see
# claw/lessons/arch_release-packages-pnpm-changesets-20260512.md.
#
# Scope is determined from `$PREPUSH_BASE` and `$PREPUSH_HEAD`, which are
# exported by .githooks/pre-push (merge-base with origin/main vs HEAD).
#
# Skip mechanism: an explicit "skip-changeset:" line in the most recent
# commit message lets us bypass the gate for genuinely release-neutral
# changes (docs-only inside cli/, test-only changes, internal refactors
# with no behavior change).  Format:
#
#     skip-changeset: <one-line reason>
#
# CI also accepts this same marker, so a PR can be merged once.

set -euo pipefail

BASE="${PREPUSH_BASE:-}"
HEAD="${PREPUSH_HEAD:-HEAD}"
if [[ -z "$BASE" ]]; then
  echo "[gate-2] PREPUSH_BASE not set; assuming this is being run standalone — skip." >&2
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Look only at files inside the four published packages, and ignore the
# auto-generated CHANGELOG.md files themselves (a CHANGELOG edit can't
# require its own changeset — that's a chicken-and-egg loop).
touched_published=$(git diff --name-only "$BASE..$HEAD" -- \
    'cli/**' 'modules/ai-sdk/**' 'modules/ai-manager/**' 'modules/conductor-sdk/**' \
  | grep -vE '(^cli/CHANGELOG\.md$|^modules/[^/]+/CHANGELOG\.md$|/\.gitignore$|/dist/)' \
  || true)

# Look for newly added changeset markdown (config.json / README excluded).
new_changesets=$(git diff --name-only --diff-filter=A "$BASE..$HEAD" -- '.changeset/*.md' \
  | grep -vE '(^\.changeset/README\.md$|^\.changeset/config\.json$)' \
  || true)

if [[ -z "$touched_published" ]]; then
  echo "[gate-2] no published-package files touched, skipping."
  exit 0
fi

if [[ -n "$new_changesets" ]]; then
  echo "[gate-2] OK ($(echo "$new_changesets" | wc -l | tr -d ' ') new changeset(s))."
  exit 0
fi

# Bypass check: scan every commit on the branch range for an opt-out marker.
if git log --format=%B "$BASE..$HEAD" | grep -qiE '^skip-changeset:'; then
  reason=$(git log --format=%B "$BASE..$HEAD" | grep -iE '^skip-changeset:' | head -1)
  echo "[gate-2] bypassed by trailer: $reason"
  exit 0
fi

echo "::error::Branch modifies a published package but ships no .changeset/*.md."
echo
echo "[gate-2] FAILED."
echo "  Published-package files touched in this branch:"
echo "$touched_published" | sed 's/^/    /'
echo
echo "  Fix:"
echo "    npm run changeset"
echo "    # pick patch/minor/major, write the one-paragraph release-notes blurb,"
echo "    # commit the generated .changeset/*.md."
echo
echo "  Or, if this branch is genuinely release-neutral (docs-only inside cli/,"
echo "  test-only changes, internal refactor with no consumer-visible behavior),"
echo "  add a 'skip-changeset: <reason>' trailer to one of your commit messages:"
echo
echo "    git commit --amend"
echo "    # ...add a line:  skip-changeset: docs-only README touch-up"
echo
echo "  See claw/lessons/arch_release-packages-pnpm-changesets-20260512.md."
exit 1
