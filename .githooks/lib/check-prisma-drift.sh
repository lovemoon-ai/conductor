#!/usr/bin/env bash
# Gate 1: schema.prisma must match prisma/migrations/, modulo a small
# allow-list of cosmetic drift accepted in
# claw/lessons/arch_cosmetic-prisma-drift-accepted-20260512.md.
#
# Only runs when the current branch actually touches web/prisma/ — most
# pushes don't, so the developer doesn't pay the ~15 s shadow-DB cost.

set -euo pipefail

BASE="${PREPUSH_BASE:-}"
HEAD="${PREPUSH_HEAD:-HEAD}"
if [[ -z "$BASE" ]]; then
  echo "[gate-1] PREPUSH_BASE not set; assuming this is being run standalone — skip." >&2
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

touched=$(git diff --name-only "$BASE..$HEAD" -- web/prisma/ || true)
if [[ -z "$touched" ]]; then
  echo "[gate-1] no web/prisma/ changes in this branch, skipping."
  exit 0
fi

echo "[gate-1] web/prisma/ touched, checking drift against prisma/migrations/"
echo "$touched" | sed 's/^/    /'

# Keep this list in sync with `ACCEPTED_DRIFT_TABLES` in
# .github/workflows/pr-checks.yml so CI and local agree.
ACCEPTED_DRIFT_TABLES=(agent_outbox user_preferences)

WEB_DIR="$REPO_ROOT/web"
PRISMA_BIN=""
for candidate in \
  "$WEB_DIR/node_modules/.bin/prisma" \
  "$REPO_ROOT/node_modules/.bin/prisma"; do
  if [[ -x "$candidate" ]]; then
    PRISMA_BIN="$candidate"
    break
  fi
done

if [[ -z "$PRISMA_BIN" ]]; then
  echo "::error::prisma CLI not found. Run 'pnpm -C web install' first." >&2
  echo "[gate-1] SKIPPED — prisma CLI missing. CI will still enforce this gate."
  exit 0
fi

cd "$WEB_DIR"
shadow_db="prisma/_pre_push_shadow.db"
rm -f "$shadow_db"

set +e
diff_output=$("$PRISMA_BIN" migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "file:./$shadow_db" \
  --exit-code 2>&1)
code=$?
set -e
rm -f "$shadow_db"

case "$code" in
  0)
    echo "[gate-1] OK: schema.prisma matches prisma/migrations/ exactly."
    exit 0
    ;;
  2)
    : # drift detected — fall through to accept-list filter
    ;;
  *)
    echo "::error::prisma migrate diff returned unexpected exit code $code"
    echo "$diff_output" >&2
    exit "$code"
    ;;
esac

# Parse "[*] Redefined table `<name>`" lines.
redefined=$(echo "$diff_output" | grep -oE 'Redefined table `[^`]+`' \
  | sed -E 's/Redefined table `([^`]+)`/\1/' | sort -u)

unaccepted=""
while IFS= read -r table; do
  [[ -z "$table" ]] && continue
  ok=0
  for accepted in "${ACCEPTED_DRIFT_TABLES[@]}"; do
    if [[ "$table" == "$accepted" ]]; then ok=1; break; fi
  done
  [[ "$ok" == "0" ]] && unaccepted="$unaccepted $table"
done <<< "$redefined"

# Conservative: any drift signal that isn't a "Redefined table" we don't
# attempt to allow-list — that catches new CREATE / DROP / ADD COLUMN
# the parser may not have a heuristic for.
non_redefine_drift=$(echo "$diff_output" | grep -E '^\[[*+-]\]' \
  | grep -vE 'Redefined table' || true)

if [[ -z "$unaccepted" && -z "$non_redefine_drift" ]]; then
  echo "[gate-1] OK: only previously-accepted cosmetic drift remains (${ACCEPTED_DRIFT_TABLES[*]})."
  exit 0
fi

echo "::error::schema.prisma diverges from prisma/migrations/ in a way not covered by the accepted-drift list."
echo
echo "[gate-1] FAILED."
echo "  Unaccepted redefined tables:${unaccepted:- (none)}"
if [[ -n "$non_redefine_drift" ]]; then
  echo "  Other drift signals:"
  echo "$non_redefine_drift" | sed 's/^/    /'
fi
echo
echo "  Fix one of:"
echo "    1. Generate a migration:"
echo "         cd web && npx prisma migrate dev --name <descriptive-name>"
echo "    2. If drift is intentional + cosmetic-only, document it in"
echo "       claw/lessons/arch_cosmetic-prisma-drift-accepted-20260512.md"
echo "       AND extend ACCEPTED_DRIFT_TABLES in BOTH:"
echo "         .github/workflows/pr-checks.yml"
echo "         .githooks/lib/check-prisma-drift.sh"
echo
echo "  NEVER paper over the drift on production with 'prisma db push'."
echo "  See claw/lessons/arch_release-packages-pnpm-changesets-20260512.md."
exit 1
