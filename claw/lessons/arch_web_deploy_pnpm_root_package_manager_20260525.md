# Web Deploy Package Manager Mismatch

## Symptom

The production Web rollout pulled the release commit successfully, then
stopped before database migration with:

```text
This project is configured to use npm because package.json has a
"packageManager" field
```

## Root Cause

The deployment script had already migrated to `npm --prefix web`, but the
manual migration commands in the production SOP still used `pnpm -C web`.
Once the repository root declared npm as its package manager, Corepack rejected
the stale pnpm command.

## Fix

Update the production deployment SOP to use `npm --prefix web` for dependency
installation, Prisma generation, and migration, matching the executable deploy
script.

## Prevention

Keep operational runbooks aligned with the commands in deployment automation,
and validate the pre-migration command sequence after changing a repository's
declared package manager.
