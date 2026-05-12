# Local git hooks for conductor

This directory holds shared git hooks that enforce the four pre-merge
gates from the 0.3.0 release retro. They're not active by default —
each contributor opts in once after cloning with:

```sh
./scripts/install-hooks.sh
```

(or, equivalently, `git config core.hooksPath .githooks`).

Uninstall with `./scripts/install-hooks.sh --uninstall`.

## Why this exists

The 0.3.0 release went out with four classes of preventable problem:

1. Prisma schema drift hit production because `db push` was used in
   place of `prisma migrate dev`. See
   `claw/lessons/arch_release-packages-pnpm-changesets-20260512.md`.
2. 20+ commits shipped to npm with no `changeset`, so the public
   `CHANGELOG.md` of `@love-moon/conductor-cli@0.3.0` only documented
   2 of the actual changes. See the same lesson.
3. A `notes-before-release/` item was open at release time; the
   release SOP treats that as a hard gate but nothing enforced it.
4. A changeset entry told operators to run `pnpm -C web db:push` on
   production. That advice is wrong (prod uses `prisma migrate
   deploy`) and shipped to the public release notes anyway.

Each gate below catches one of those at the earliest possible point.

## Gates and where they run

| # | What it checks | Hook | Also in CI |
|---|---|---|---|
| 1 | `prisma migrate diff` between `schema.prisma` and `prisma/migrations/`, modulo the accepted-drift allow-list. Only when the branch touches `web/prisma/`. | `pre-push` | `.github/workflows/pr-checks.yml` |
| 2 | Any change inside `cli/**` or `modules/ai-sdk/`, `modules/ai-manager/`, `modules/conductor-sdk/` must ship a new `.changeset/*.md`. Bypass with a `skip-changeset: <reason>` trailer in any commit message on the branch. | `pre-push` | same |
| 3 | `claw/notes-before-release/` is non-empty | (none — release-time only) | `.github/workflows/release-packages.yml` |
| 4 | No changeset markdown can contain `db push` / `db:push` / `prisma db push`. | `pre-commit` (staged) + `pre-push` (branch diff) | `.github/workflows/pr-checks.yml` |

Gate 3 deliberately is **not** a local hook. A `notes-before-release/`
item routinely stays open for days while QA finishes a feature; if it
blocked every `git commit` or `git push` during that window the rest
of the team couldn't work. It only fails at release time, server-side.

## What "ship" means

- Pre-commit runs `check-changeset-no-db-push.sh --staged`.
- Pre-push runs the full battery (prisma drift + changeset presence
  + db-push lint) against `git merge-base origin/main HEAD ..HEAD`.
- CI re-runs the same logic. Bypassing locally (`git commit
  --no-verify`, `git push --no-verify`) only delays the same failure
  until the CI run.

## Accepted-drift allow-list

The Prisma drift gate has a small allow-list for tables whose schema
diverges in cosmetic (NULL vs NOT NULL on default-having columns,
DDL-default-only differences) ways that we've decided NOT to fix —
see `claw/lessons/arch_cosmetic-prisma-drift-accepted-20260512.md`.

The list is defined twice and the two MUST stay in sync:

- `.github/workflows/pr-checks.yml` → `ACCEPTED_DRIFT_TABLES`
- `.githooks/lib/check-prisma-drift.sh` → `ACCEPTED_DRIFT_TABLES`

When you extend it, document the new entry in the lesson above.

## Skipping in an emergency

- `git commit --no-verify` — skips pre-commit (only Gate 4 short-form)
- `git push --no-verify` — skips pre-push (Gates 1, 2, 4)
- CI cannot be skipped without admin override; that's the point.

If you find yourself reaching for `--no-verify` more than once a week,
the hook is wrong — open an issue rather than building a habit of
bypassing.
