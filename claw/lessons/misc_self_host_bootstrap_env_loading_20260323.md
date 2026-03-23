# misc: self-host bootstrap and prisma env loading miss .env.production.local (2026-03-23)
## Problem performance
- A self-host operator could follow the documented production setup, create `web/.env.production.local`, and still hit failures in `pnpm db:push` or `pnpm bootstrap:self-host`.
- In that path, Prisma CLI could fail with missing `DATABASE_URL`, and the bootstrap script could fall back to `http://localhost:6152` or the wrong database if env vars were not exported manually.

## Cause analysis
- The app, Prisma CLI, and bootstrap script did not share one environment-file resolution rule.
- `bootstrap:self-host` originally preferred `.env.production.local` only when `NODE_ENV=production` was set explicitly.
- `prisma.config.ts` only loaded `.env`, so the documented self-host production flow did not match the actual runtime behavior of `pnpm db:generate` and `pnpm db:push`.

## Solution
- Introduce a shared env loader in `web/env-utils.ts`.
- Reuse the shared env resolution in both `web/prisma.config.ts` and the self-host bootstrap script.
- Prefer `.env.production.local` for the self-host and production-oriented setup flow, while keeping sane fallbacks.
- Add regression tests for env-file selection, bootstrap base-url fallback, and concurrent bootstrap create collision fallback.

## How to avoid it next time
- Any documented deployment or bootstrap path must use the same env resolution logic as the actual code path; do not duplicate rules in separate files.
- When adding a new operator workflow, include at least one test for config/env discovery, not just business logic.
- For setup docs, run the exact documented commands end to end before merging.
