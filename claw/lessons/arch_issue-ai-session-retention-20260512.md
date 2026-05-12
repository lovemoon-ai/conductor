# Issue retains aiBackendType / aiSessionId after task delete — release acceptance

- Date promoted: 2026-05-12 (from `claw/notes-before-release/issue-ai-type-session-retention-20260508.md`)
- Source feature commits: `26d1946 persist ai backend type and session id on issue`,
  `ebe82df backfill issue ai session breadcrumb and surface it on the board`,
  `1fc4e6b backfill issue ai session breadcrumb at server boot`,
  `63eb157 keep ai breadcrumb on issue store and drop card badge`
- QA round 2: `claw/issues/issue-retain-ai-type-and-session-after-task-delete-20260508/test_report_round_2.md`
  closed `passed_with_known_issues` (0 P0 / 0 P1 / 1 P2)

The pre-release note that lived under `notes-before-release/` is cleared with the
release that ships these commits. This lesson records the decisions taken so
future work doesn't re-litigate them.

## Symptom

Tasks were the only carrier of `backend_type` / `session_id`. When a user deleted
the task that produced an issue's AI session, the issue lost the breadcrumb
needed to 回溯 the original AI conversation.

## Root cause

`issues` had no columns for AI provenance, so the data only survived as long as
the originating task row existed.

## Fix

Two nullable columns on `issues` — `ai_backend_type`, `ai_session_id` — plus
three write paths and one read path:

- **Write — task create**: `web/src/lib/tasks/create-ai-task.ts:208-216` calls
  `persistIssueAiSession(...)` after `task.create`.
- **Write — in-place restart**: `web/src/lib/tasks/inplace-restart.ts:257-265`
  mirrors the source task's backend + session id inside the restart transaction.
- **Write — PATCH /api/tasks/[taskId]**: `web/src/app/api/tasks/[taskId]/route.ts:876-890`
  mirrors after the task patch commits (best-effort, swallowed on failure).
- **Read — IssueDetailsDialog**: `web/src/features/issues/components/IssueDetailsDialog.tsx`
  prefers active/linked task values, then falls back to the persisted
  `aiBackendType` / `aiSessionId` so the dialog still surfaces the breadcrumb
  after every task is deleted.
- **Boot-time backfill**: `web/server.ts:74` fires
  `backfillIssueAiSessionIfNeeded()` as `void`. The function
  (`web/src/lib/issues/backfill-ai-session.ts`) runs two idempotent UPDATEs that
  match only rows where the breadcrumb is still NULL and a source value exists.
  Schema-mismatch (P2022) is swallowed with a single warn.

## Decisions locked in for this release

1. **Persistence semantics**: latest non-empty wins. Empty / null inputs never
   wipe a previously captured value (`persist-ai-session.ts` `if (backendType)`
   guard). Restart with a new session id overwrites; multiple tasks linked to
   the same issue over time → the most recent non-null write is the one that
   sticks. Tested in `persist-ai-session.test.ts`.
2. **`aiSessionId` is treated as an opaque trace key**, not PII. Plain text in
   DB, no special log retention treatment. If that classification changes,
   revisit the log/export paths.
3. **Boot backfill does not block `/ready`**: `void backfillIssueAiSessionIfNeeded()`
   in `server.ts` runs in parallel with `server.listen`. No `await`.
4. **IssueCard badge gap (P2 from QA round 2)** is resolved by surfacing the
   breadcrumb in `IssueDetailsDialog`'s session list, not by re-rendering the
   AI-type badge on the IssueCard. Decision recorded in commit `63eb157`.
5. **Migration safety**: the `20260430120000_issue_ai_session_fields` migration
   only does `ALTER TABLE … ADD COLUMN <TEXT>` (nullable, no default). SQLite
   treats this as metadata-only — no table rewrite, no long lock, online safe.
   The follow-up `20260501010000_backfill_issue_ai_session_from_tasks` migration
   runs the same backfill as the boot hook but inside `prisma migrate deploy`.
   The boot hook exists because Conductor's `pnpm db:push` path does not replay
   migration files.

## Accepted limitations (do not block this release)

- **`stable_daemon_ws_10s_reconnect_loop_20260424`**: on flaky links the
  reconnect loop can kill a task before its backend emits a session id, leaving
  the issue with `aiBackendType` populated but `aiSessionId=null` permanently.
  Tracked in its own issue file. Affected users are a minority and the
  breadcrumb is best-effort by design.
- **`frontend-issue-linked-task-remains-openable-after-kill-20260421`**: lives
  in the same UX area; ships independently.
- **No ops metric** beyond the boot log line
  `[issue-ai-session-backfill] backfilled N ai_backend_type and M ai_session_id values from existing tasks`.
  Volc is single-instance today; a metric is overkill.
- **Mixed-version coverage in `claw/sop/05_qa.md §5`** is not added in this
  release. Old daemon → new server is safe (empty fields skip the write).
  New daemon → old server is safe (old server ignores unknown fields). The QA
  SOP update is a follow-up, not a blocker.

## How to avoid the issue next time

- New columns that the UI relies on should ship with **three** things in the
  same PR: a migration, application-layer write paths in every entry that
  produces the value, and a **boot-time idempotent backfill** for `db push`
  installs. Skipping any of the three leaves a sub-population of installs
  permanently empty.
- Treat `void <fire-and-forget>()` at startup as a deliberate contract: the
  function must never throw and must be cheap on a no-op pass. Document it
  in the call site comment so a future refactor doesn't add `await`.
- When QA closes a round `passed_with_known_issues`, file the open items in
  `claw/notes-before-release/` immediately. The hard release gate forces the
  team to actually resolve / accept / promote them rather than forgetting.

## Rollback story

- Code rollback to before commit `a40ba9c` is safe: the new columns are
  nullable and pre-feature code ignores them.
- **Do not roll back the schema.** Leave the columns; the next release will
  re-use them.
- If the boot-time backfill ever becomes a hot-path problem (long boot, lock
  contention), it can be disabled with a one-line gate around the `void`
  call in `server.ts`. Write-path persistence keeps working.
