# Volc production build fails due to Prisma Client expiration

## Symptoms
- 2026-03
- 06 When executing `bash scripts/deploy-prod.sh` on the Volc machine, `next build` fails in the TypeScript check phase.
- The error location is at `web/src/app/api/tasks/[taskId]/route.ts`, indicating that `task.backendType` does not exist.
- The same code has added the `backendType` field in the schema, but the Prisma Task type seen during the build is still the old version.

## Root Cause
- `scripts/deploy-prod.sh` executes `npm --prefix web run build` first, then `npm --prefix web run db:generate`.
- The type check for `next build` depends on the current `@prisma/client` generation result.
- When the schema is changed first and the Prisma client has not been regenerated, the build will continue to use the old type, causing the new fields to be invisible at compile time.

## Fix
- Advance Prisma client build step before production build.
- At the same time, change the `build` script in `web/package.json` to `prisma generate && next build` so that both the local and remote ends use the same safe path.

## Prevention
- Any build process that relies on Prisma schema changes should ensure that `prisma generate` occurs before `next build`.
- Check the order of the "generate code" step in the deployment script to avoid the reverse dependency of "build and then generate".
- Add a local or CI verification to key deployment scripts, covering at least paths like `pnpm build` that will trigger type checking.