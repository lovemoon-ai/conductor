# Issue priority schema fallback missed the doing-to-done stop path

**Bug type:** arch
**Date:** 2026-04-22

## Symptom

- Issue priority rollout added a fallback for databases that had not applied the `issues.priority` migration yet.
- List/detail reads and normal issue edits worked, but moving a `doing` issue to `done` while it had an active linked task could still fail with Prisma `P2022` about the missing `issues.priority` column.
- In the web UI this showed up as a failed status change even though the rest of the priority rollout was meant to stay usable before migration.

## Root Cause

- `web/src/app/api/issues/[issueId]/route.ts` introduced `effectiveIssueUpdateArgs` so PATCH could omit `priority` when the schema was unavailable.
- Most PATCH branches used that fallback, but the `shouldKillActiveTask` transaction path still called `tx.issue.update(issueUpdateArgs)`, which always selected and wrote `priority`.
- The regression was not caught because compatibility tests covered list/detail reads and straight-line PATCH updates, but not the `doing -> done` branch that stops an active issue task.

## Fix

- Switched the `shouldKillActiveTask` branch to use the shared `effectiveIssueUpdateArgs`.
- Added a regression test that simulates a missing `issues.priority` column while moving a `doing` issue to `done`, and asserts that the update omits `priority` and still returns the default `P1`.

## How To Avoid Next Time

1. When adding rollout-compatibility args, route every write branch through the same prebuilt update object instead of keeping branch-local update calls.
2. Treat state-machine branches as separate rollout surfaces; fallback tests need to cover each transition path, not just the simplest PATCH case.
3. When a review finds a missing compatibility path, add the regression test before closing the follow-up so later refactors cannot reopen the gap.
