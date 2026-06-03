# Bug: `make run-dev` fails when Prisma schema adds required columns to existing table

## Symptom

Running `make run-dev` fails at the `pnpm db:push` step with:

```
⚠️ We found changes that cannot be executed:

  • Added the required column `creator_user_id` to the `issues` table without a default value. There are 1 rows in this table, it is not possible to execute this step.
  • Added the required column `owner_user_id` to the `issues` table without a default value. There are 1 rows in this table, it is not possible to execute this step.

You may use the --force-reset flag to drop the database before push like prisma db push --force-reset
All data will be lost.
```

## Root Cause

Commit `5d63a1a` ("fix collaboration issue scope") introduced `ownerUserId` and `creatorUserId` as **required** `String` fields on the `Issue` Prisma model. When developers with existing local SQLite databases pull this change, `prisma db push` (which is invoked by both `make run-dev` and `pnpm dev`) cannot apply the schema change because SQLite cannot add a `NOT NULL` column to a table that already contains rows without providing a default value.

Although the application code already treated these fields as optional (e.g., `ownerUserId?: string | null` in API types, `serializeIssueUser` handling `null`/`undefined`), the Prisma schema declared them as non-nullable, creating a mismatch between the code's runtime expectations and the database's structural requirements.

## Fix

Changed `ownerUserId` and `creatorUserId` from required (`String`) to optional (`String?`) in `web/prisma/schema.prisma`, and made their corresponding relations (`owner` and `creator`) optional as well (`User?`):

```prisma
model Issue {
  ...
  ownerUserId   String?  @map("owner_user_id")
  creatorUserId String?  @map("creator_user_id")
  ...
  owner   User?   @relation("IssueOwner", fields: [ownerUserId], references: [id], onDelete: Cascade)
  creator User?   @relation("IssueCreator", fields: [creatorUserId], references: [id], onDelete: Cascade)
  ...
}
```

This allows `prisma db push` to add the columns as nullable, which SQLite handles gracefully even when the table has existing rows.

## How to Avoid This Next Time

1. **When adding new columns to an existing table in a `db:push`-based workflow, default to nullable (`?`) unless there is a strict business requirement for non-nullability AND a migration path for existing data.**
2. **If a column truly must be required, provide a `@default(...)` value or create a proper Prisma migration that backfills existing rows before applying the `NOT NULL` constraint.**
3. **Keep schema constraints aligned with application-layer type expectations.** If the API accepts a field as optional, strongly consider making the database column optional too, unless there is a deliberate enforcement layer that guarantees presence at insert time.
