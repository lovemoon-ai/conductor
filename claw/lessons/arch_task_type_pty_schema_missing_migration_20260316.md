# After the online tasks capability was released, the core interface failed due to missing migration.

## Symptoms
- After the release on 2026-03
- 16, online users cannot create tasks, delete tasks, or send messages.
- A large number of Prisma `P2022`:`main.tasks.task_type does not exist` appear in `web` logs.
- Affected paths include task list/create, `/api/tasks/[taskId]/messages`, agent event uplink and other core links.

## Root Cause
- This function adds `Task.taskType` (mapping `task_type`), `launchConfig` to `web/prisma/schema.prisma`, and introduces `PtySession`.
- But there is no corresponding `web/prisma/migrations/*` migration file in the submission.
- `No pending migrations` is displayed when the deployment process executes `prisma migrate deploy`, resulting in the production database structure not being changed, but the new code has been queried according to new columns, which ultimately triggers a runtime error.
## Fix
- Online emergency repair: Back up `conductor.db` first, then execute `pnpm -C web db:push` synchronization schema to restore availability.
- Long-term repair of the warehouse: complete the official migration (added `task_type`, `launch_config`, `pty_sessions` tables and indexes), and the subsequent environment can be upgraded consistently through `migrate deploy`.

## Prevention
- Any modification to `schema.prisma` must be submitted simultaneously; the PR check item must include "whether the schema change is accompanied by migration".
- Added a "schema changes but migrations unchanged" blocking check before deployment to avoid going online without migration.
- Smoke test (create tasks, send messages, delete tasks) after releasing the core task API to detect structural inconsistencies as early as possible.