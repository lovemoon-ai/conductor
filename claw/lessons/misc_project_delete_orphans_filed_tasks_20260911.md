# misc: Deleting a project orphaned tasks filed under it

## Symptom

A task filed under project B with the task-card "move to project" action (which
only sets the display-only `Task.secondProjectId`) vanished from every project
view after B was deleted from the web UI. The task itself was not deleted — its
real project was untouched — but it no longer appeared under its home project,
only in the unfiltered "all tasks" view, so it looked lost.

## Root cause

There are two project DELETE routes: `/api/projects/[projectId]` and
`/api/projects?projectId=`. When `secondProjectId` was introduced, the "clear
overrides pointing at the deleted project" step was added only to
`[projectId]`, and only that route's test asserted it. The web UI
(`features/projects/store.ts` `deleteProject`) calls the other route. With no
FK on `secondProjectId`, the override was left dangling: the display-grouped
task list excluded the task from its home project (override set) while the
target project no longer existed.

## Fix

`DELETE /api/projects?projectId=` now clears `secondProjectId` for tasks filed
under the deleted project inside the delete transaction, gated on the same
schema probe as the achieved-task re-home, with a route test on the path the UI
actually calls.

## How to avoid next time

- When a step must hold on "every delete path", grep every handler that deletes
  the row (here: both project DELETE routes) and add the step plus a test to
  each. Don't assume the route covered by an existing test is the live one.
- Before calling a route "legacy", check which one the UI store really calls.
- A soft reference column without an FK (like `secondProjectId`) needs explicit
  cleanup wherever its target row can be deleted.
