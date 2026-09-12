# Mocked Prisma hid a legacy issue-create fallback that could never work

**Bug type:** arch
**Date:** 2026-09-12

## Symptom

- Adding the `issues.type` column (feature/bug/research) surfaced a latent failure in the pre-migration compatibility path.
- On a database where a post-original `issues` column is absent (code deployed before `db:push` ran), `POST /api/issues` returned **HTTP 500** with a raw Prisma `P2022` stack instead of an actionable error.
- Reads degraded correctly the whole time — `GET /api/issues`, issue detail, and `PATCH` of ordinary fields all returned 200 — so the gap was invisible from the UI until someone tried to create an issue.
- The same failure reproduces on `issues.priority` alone, so this predates the `type` work: the legacy create fallback had **never** worked against a real database.
- Every unit test was green, including a test specifically written to cover this path.

## Root Cause

- `priority` and `type` are both `NOT NULL` columns carrying schema-level `@default(...)` values. **Prisma emits such columns in every generated `INSERT`, even when the `data` object omits them.**
- The create fallback in `web/src/app/api/issues/route.ts` was built on the opposite assumption: on `P2022` it retried `db.issue.create()` with a `data` object that deliberately left out `priority` (later `type`), expecting Prisma to skip the missing column. Prisma writes it anyway, so the retry re-raised `P2022` outside the `catch` and became a 500.
- **The retry was structurally impossible, not merely buggy.** No ordering or message fix could make it succeed while the column is absent.
- The defect survived because the covering test mocked the very thing whose behavior was in question:

  ```js
  vi.mocked(db.issue.create)
    .mockRejectedValueOnce(missingPriorityColumnError())
    .mockResolvedValueOnce({ id: 'issue-compat', ... })   // asserts the impossible retry succeeds
  ...
  expect(response.status).toBe(200);                       // asserts 200 where reality is 500
  expect(calls[1][0].data).not.toHaveProperty('priority');
  ```

  `mockResolvedValueOnce` did not *test* the fallback — it *defined* it. The test encoded the author's assumption about Prisma's INSERT behavior as a fact, so it passed precisely because it replaced the component that would have failed. A green test was actively certifying broken behavior.
- This is a repeat: `arch_issue_priority_schema_fallback_done_transition_20260422.md` closed with "added a regression test that simulates a missing `issues.priority` column". That test was added, it passed, and it was wrong — the previous lesson's own remedy carried the flaw. The create path was never validated against real SQL by either round.
- A secondary defect found in the same pass: `isMissingIssuePriorityColumnError` had been broadened to also match `type`, while still driving the priority-specific 409 body and the `issues.priority column is missing` log line. A database missing only `type` therefore reported that *priority* was unavailable, sending operators after the wrong column.

## Fix

- Deleted the impossible legacy create retry (~18 lines). `POST /api/issues` now returns a `409` naming the column that is actually missing, with the `pnpm -C web db:push` remediation. Fixes the `priority` instance as well as `type`.
- Split the detector into `isMissingIssuePriorityColumnError` (priority only), `isMissingIssueTypeColumnError`, and `isMissingIssueExtendedColumnError` (any post-original column, used to trigger the read fallbacks). Added `issueSchemaUnavailableMessage(error)`, which keys the 409 body on the missing column rather than on the field the caller tried to set, and made the warn log neutral.
- `withIssuePrioritySchemaFallback` now also returns the caught `schemaError` so PATCH can name the right column.
- Rewrote the misleading unit test to assert the real behavior (409, and `create` called exactly **once** — proving the retry was removed, not reordered) and added a case asserting the 409 blames `type`, not `priority`, when only `type` is missing.
- Verified end-to-end against real SQLite rather than mocks: throwaway DB, full `prisma migrate deploy` chain, real `server.ts`, HTTP via curl, on three DB variants — fully migrated, `type` column dropped, and `priority` column dropped.

## How To Avoid Next Time

1. **A mock can verify *what you called*, never *how the callee responds*.** Any assertion that implies "the mocked thing succeeds / returns X" is your hypothesis wearing a passing test's clothing. When the behavior under test *is* the callee's behavior, a mock cannot test it at any fidelity.
2. **Schema-compatibility and other degradation paths must be exercised against a real database.** Such a path is a bet on how the driver reacts to a broken/partial schema — exactly the one question a mocked driver cannot answer. Verify with a throwaway DB (`prisma migrate deploy` into a temp file, never the shared `dev.db`) and drop the column to reproduce the pre-migration state.
3. **Prefer refusing to degrade over pretending to.** A `NOT NULL` column with a schema default cannot be omitted from a Prisma INSERT, so no write fallback exists for it. Returning a clear 409 that names the missing column beats a retry that can only produce a 500.
4. **When a fallback covers several columns, keep detection and messaging per-column.** One conflated predicate driving a column-specific error body will misreport the root cause the moment a second column joins the group.
5. **Treat "added a regression test" as unfinished until you know the test can fail.** Delete the fix and confirm the test goes red. A mock-based test for a driver-behavior bug will stay green both ways.
6. **Known remaining gap:** this repo still has no real-database integration layer, and the tests added here are still mock-based (with their assertions corrected from real-DB observation). Until such a layer exists, changes to `web/src/app/api/issues/*` compatibility paths need a manual real-SQLite pass.
