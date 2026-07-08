# Bug: Nullable issue user columns drifted from migrations

## Symptom

The pre-push Prisma drift gate failed during a web release after `web/prisma/`
was touched:

```
Unaccepted redefined tables: issues
```

## Root Cause

The Prisma schema made `Issue.ownerUserId` and `Issue.creatorUserId` nullable,
but the committed migrations still rebuilt `issues` with `owner_user_id` and
`creator_user_id` as `TEXT NOT NULL`. Fresh databases and production
`prisma migrate deploy` would therefore converge to a stricter table than the
current application schema.

## Fix

Added a forward migration that redefines `issues` with nullable
`owner_user_id` and `creator_user_id`, preserving existing rows, foreign keys,
and indexes.

## How to Avoid

When changing nullability in `schema.prisma`, always add a matching migration
instead of relying on local `db:push`. Run the Prisma drift gate before release
when any `web/prisma/` file changes.
