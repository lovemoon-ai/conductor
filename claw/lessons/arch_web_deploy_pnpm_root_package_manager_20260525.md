# Web Deploy Package Manager Mismatch

## Symptom

The production Web rollout pulled the release commit successfully, then
stopped before database migration with:

```text
This project is configured to use npm because package.json has a
"packageManager" field
```

## Root Cause

The deployment script had already migrated to npm, but the manual migration
commands in the production SOP still used `pnpm -C web`. Once the repository
root declared npm as its package manager, Corepack rejected the stale pnpm
command. The first replacement also used `npm --prefix web exec`, which does
not change Prisma's working directory and therefore could not locate
`web/prisma.config.ts`.

## Fix

Update the production deployment SOP to use `npm --prefix web` for dependency
installation and Prisma generation, matching the executable deploy script. Run
`npm exec -- prisma migrate deploy` from the `web/` directory so Prisma resolves
its application-local configuration and schema.

## Prevention

Keep operational runbooks aligned with the commands in deployment automation,
and validate the pre-migration command sequence after changing a repository's
declared package manager.
