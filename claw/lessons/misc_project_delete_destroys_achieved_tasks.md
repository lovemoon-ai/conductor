# misc: Deleting a project destroyed its achieved (packed) tasks

## Symptom

Deleting a project hard-deleted every task whose `projectId` pointed at it —
including achieved (packed) tasks. The whole point of packing is that the
transcript "stays searchable in the Achieved-task manager for later
retrieval", yet a project delete silently destroyed those transcripts
(messages, attachments, task rows) via `task.deleteMany({ where: { projectId } })`
plus the `Project` → `Task` FK cascade.

## Root cause

The achieve feature marks a task with `achievedAt` but leaves `projectId`
unchanged. The two project DELETE routes (`/api/projects/[projectId]` and the
legacy `/api/projects?projectId=`) predate the feature and delete by
`projectId` without excluding `achievedAt != null`, and nothing re-homes the
survivors before `project.delete` fires the FK cascade. Two lifecycle features
(packing, project deletion) each held an invariant the other broke.

## Fix

In both DELETE routes:

1. Exclude achieved tasks from stop/cleanup/delete (`achievedAt: null` filter);
   their runtime was already torn down at achieve time and their messages and
   attachments must be preserved.
2. Inside the delete transaction, re-home achieved tasks to the user's default
   project (`projectId = default, secondProjectId = null`) before
   `project.delete`, so the FK cascade cannot reach them. `ensureDefaultProject`
   is the fallback when the default mapping is missing, with a guard against it
   resolving to the project being deleted.
3. Pre-migration schemas without `achieved_at` keep the legacy
   delete-everything behavior via the `isMissingPtySchemaError` probe pattern
   (nothing can be achieved on such a schema, so it is semantically identical);
   the `secondProjectId` revert is gated behind the same probe because a P2022
   inside the transaction aborts the whole delete.

## How to avoid next time

- When adding a soft-archive flag to a row (like `achievedAt`), grep every
  `deleteMany`/cascade path that can reach that table and decide explicitly
  whether archived rows survive. An archive feature is only as durable as the
  most aggressive delete path that can still see the rows.
- Any new query on a recently migrated column in a request path must follow
  the repo's missing-column fallback pattern (`pty-compat.ts`); mixed-version
  deployments are a supported scenario here.
- Prefer resolving "where do survivors go" (re-home target) outside the
  transaction but applying the move inside it, with the where-clause as the
  single source of truth, to avoid count-then-act races.
