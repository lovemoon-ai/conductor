# Test Report — Round 1

- Date: 2026-05-08
- Build SHA under test: `ce53a52` on `main`
- Web URL: `http://localhost:6152/`
- Dev CLI: `./bin/conductor-dev` — `conductor version 0.2.42 (f79f36f)`
- Backend: local dev (Prisma sqlite)
- Driver: `chrome-devtools` MCP for UI verification, `curl` against `/api/...` for backend assertions
- Plan: `claw/issues/issue-retain-ai-type-and-session-after-task-delete-20260508/test_plan.md`

## Conclusion

**inconclusive (pending re-verification)** — TC-02 reproduced on the legacy issue rows present in the dev DB, but `git log` shows commit `26d1946 persist ai backend type and session id on issue` already in `main`. The observed `null` values may therefore be pre-fix residue rather than a current regression. A draft P0 bug ticket exists at `claw/issues/arch-issue-loses-ai-type-and-session-after-task-delete-20260508.md` (intentionally not committed for this round); it must be re-verified on a freshly-created issue + task — produced after the fix landed — before being escalated. See "Notes / deviations" below.

## Severity counts

- blocker (P0): 0 confirmed; 1 candidate pending re-verification (see Conclusion).
- major (P1): 1 candidate — UI surface exposes neither field at any point in the lifecycle on the legacy data observed; needs re-verification after a fresh round.
- minor (P2): 0

## Per-case outcome

| ID | Title | Result | Severity (if fail) | Evidence |
| --- | --- | --- | --- | --- |
| TC-01 | Issue carries aiType + aiSessionId before deletion (baseline) | **failed** | blocker | `evidence/issue_72427fdd_before_delete.json` — `aiBackendType=null`, `aiSessionId=null` while `linkedTask.backend_type=codex`, `linkedTask.session_id=019daec0-…`. Same on a second issue `062e20d4` (`evidence/issues_list_after_delete.json`). |
| TC-02 | Issue still carries aiType + aiSessionId after task is deleted | **failed** | blocker | `evidence/issue_72427fdd_after_delete.json` — after `DELETE /api/tasks/15bda6a9-…` returned `204`, the issue's `aiBackendType=null`, `aiSessionId=null`, `linkedTask=null`, `metadata=null`. All trace of `codex` / `019daec0-…` is unreachable from the issue surface. |
| TC-03 | List vs detail consistency | **passed (vacuously)** | — | List and detail agree — both return the same `null` for `aiBackendType` / `aiSessionId`, so they are consistent in their failure to carry the value. |
| TC-04 | UI exposes the retained traceability | **failed** | major | `evidence/issues_page_after_delete.png` and the issues-page snapshot show no AI-type label, no session id label, no copy / detail control surfacing either field. The only per-issue affordances are change-status, optional `Open last task` (only when a non-deleted linked task exists), and delete. |
| TC-05 | Same retention after a hard refresh / navigation | **failed** | blocker (rolled into TC-02) | After-delete payload was fetched on a fresh `GET`; no client-cache effects in play. |
| TC-06 | User boundary | **inconclusive** | — | Only the dev account was available; second account not part of this round. Not a regression risk for this requirement. |

## Bug list

1. *(held)* `claw/issues/arch-issue-loses-ai-type-and-session-after-task-delete-20260508.md` — drafted but not committed this round. `git log` shows `26d1946 persist ai backend type and session id on issue` already merged to `main`, so the observed null values may be pre-fix legacy data. Re-verify on a freshly-created issue + task before promoting.

## Known issues carried over

- `claw/issues/frontend-issue-linked-task-remains-openable-after-kill-20260421.md` is in the same area (issue ↔ linked-task lifecycle) and is still open. Its acceptance criterion explicitly excludes the *deleted* case, so it neither overlaps with nor blocks the bug filed in this round. They should be addressed together because both stem from the issue model relying on the live task as the only source of truth.

## Notes / deviations from the plan

- Did not bring up a new dev daemon: the system-wide `conductor` daemon (PID 11299) holds the same lockfile, and stopping a system daemon was outside the safe blast radius for this round. The five issues observed in the dev DB were all created earlier (April 2026), so they predate `26d1946` — which is precisely why their `aiBackendType` / `aiSessionId` are null. A re-run that creates a fresh issue + task with a dev daemon online is required to determine whether the requirement is met on current behavior.
- `chrome-devtools` MCP captured the issues-page screenshot and snapshot for TC-04; CLI `conductor diagnose` was not used because the failure is observable purely through the issue API surface.
