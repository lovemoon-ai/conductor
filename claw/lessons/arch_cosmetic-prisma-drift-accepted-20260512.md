# Cosmetic Prisma drift on `agent_outbox` and `user_preferences` — accepted

- Date: 2026-05-12
- Source: post-release-0.3.0 audit; `prisma migrate diff
  --from-migrations prisma/migrations --to-schema-datamodel
  prisma/schema.prisma --exit-code` exit code `2`, redefined tables
  `agent_outbox` and `user_preferences`.

## Observed drift

| Table | Drift | Effective impact |
|---|---|---|
| `agent_outbox.max_attempts` | Migration `20260306100000_outbox_ttl_dlq` adds the column as `INTEGER DEFAULT 20` (nullable). Schema declares `Int @default(20)` (NOT NULL DEFAULT 20). | None — `ALTER TABLE … ADD COLUMN … DEFAULT 20` populates every existing row with 20 in SQLite, and the same backfill migration `UPDATE`s any straggler `status='pending'` rows. As of this release volc has 7425 rows, **0 NULL**. |
| `agent_outbox.ttl_hours` | Same pattern as `max_attempts`. | Same: 7425 rows, 0 NULL on volc. |
| `user_preferences.updated_at` | Migration declares `DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`. Schema declares `@updatedAt` (NOT NULL, no DB default — Prisma sets it on every write). | None — the column is already NOT NULL in DB; the only difference is the DDL-level default expression, which Prisma never relies on. |
| `user_catchphrases.updated_at` | Same pattern as `user_preferences.updated_at`: migration `20260606120000_user_catchphrases/migration.sql` declares `DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`, schema declares `@updatedAt`. Accepted at release time alongside RFC 0032 (Catchphrase Management). | Same: column is NOT NULL in DB, default expression is DDL-level only and Prisma never reads it. |

## Decision

**Do not fix in this release.** Reasoning:

- The drift is provably non-functional on volc (verified by `SELECT
  COUNT(*) - COUNT(col)` returning 0 for every affected column).
- Eliminating the drift requires SQLite-style table rewrites
  (`new_agent_outbox` → `INSERT … SELECT … FROM agent_outbox` → `DROP
  TABLE agent_outbox` → `RENAME` plus index recreation) on a 7k-row
  hot table that the daemon reads/writes continuously.
- A failed rewrite mid-flight could leave `agent_outbox` in an unusable
  state, whereas the current state is functionally correct.
- The only "cost" of leaving the drift is that `prisma migrate diff
  --exit-code` returns 2 and `prisma migrate dev` warns developers. The
  warning is harmless and the SOP already runs `migrate deploy` (not
  `migrate dev`) in production.

## When to fix

Revisit if any of these become true:

1. We move agent_outbox to Postgres (the table-rewrite cost vanishes —
   ALTER TABLE … ALTER COLUMN … SET NOT NULL is O(table) but
   non-locking with `CONCURRENTLY` on PG 12+).
2. We start running `prisma migrate dev` in CI and need a clean diff.
3. A future schema change happens to touch `agent_outbox` or
   `user_preferences` anyway and the same migration can fix the NOT
   NULL constraint as a bonus.

## How to avoid this kind of drift next time

- Every schema-altering PR should run `prisma migrate diff
  --from-migrations prisma/migrations --to-schema-datamodel
  prisma/schema.prisma --exit-code` as part of review and either
  produce a migration or update this lesson with an explicit accept.
- `prisma db push` should only be used on a developer's local DB,
  never as the canonical schema-sync mechanism. The drift documented
  above (and the missing `git_remote_url` / `merge_opt_out` / invite
  columns we fixed in release 0.3.0) all came from `db push`
  shortcuts.
