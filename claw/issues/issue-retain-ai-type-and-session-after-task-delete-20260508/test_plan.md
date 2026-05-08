# Test Plan — Issue retains aiType and aiSessionId after linked task deletion

Date: 2026-05-08
Author: QA (per `claw/sop/05_qa.md`)

## Scope

- Issue feature on the web app (issue list / card / detail).
- HTTP API surface for issues (`/api/issues`, `/api/issues/[issueId]`) — observed via the UI's network panel and (if needed) `curl`.
- Black-box only: derive expected behavior from the user-supplied requirement and existing related issue
  `claw/issues/frontend-issue-linked-task-remains-openable-after-kill-20260421.md`. No reading of source files.

## Out of scope

- Whether the deleted task remains openable from the issue (covered by the prior 20260421 issue, not by this round).
- Issue list visual polish, styling, copy.
- Cross-user sharing of issue history.
- Multi-task / restart history beyond a single linked task.

## Requirement under test (as given)

> 即使 issue 关联的 task 删除了，issue 还是要保留对应的 ai 类型和 ai session id，方便后续回溯。

Restated as black-box expectations:
- When an issue's linked task is deleted, the issue MUST still carry an observable `aiType` (the AI agent kind, e.g. `claude_code` / `codex` / `copilot`) and an `aiSessionId` (the per-session identifier produced by that AI agent during the task).
- These two fields must be reachable from a public surface — the issue API response and/or the issue UI — so the user can later trace which agent and which session originally produced the issue's outcome.
- These fields should equal the values the linked task carried while it was still alive.

## Environment

- Server: local build at `http://localhost:6152/`, repo SHA `ce53a52` (`main`).
- Dev CLI: `./bin/conductor-dev` — `conductor version 0.2.42 (f79f36f)`.
- Daemon config: `~/.conductor/config-dev.yaml`.
- Sign-in: `env:CONDUCTOR_PHONE` via `chrome-devtools` MCP.
- Backend: dev (local SQLite via Prisma).

## Test data

- One signed-in account (the dev phone).
- One project bound to the dev daemon host.
- One issue created from the UI.
- One task spawned from that issue, run long enough to get an `aiSessionId` recorded.

## Cases

### TC-01 (blocker) — Issue carries aiType + aiSessionId before deletion (baseline)
- Preconditions: signed in; daemon online; project exists; AI provider configured.
- Steps:
  1. Create an issue from the UI.
  2. From the issue, dispatch / link a task that runs an AI session (e.g. ask the agent to run a trivial command).
  3. Wait for at least one assistant reply so that an `aiSessionId` is recorded.
  4. Capture the issue's API payload (network tab or `curl /api/issues/<issueId>`).
- Expected: payload shows `aiType` (or equivalent agent-kind field) and `aiSessionId` populated, matching the linked task.
- Severity if missing: **blocker** — without a baseline we cannot evaluate retention.
- Evidence: chrome-devtools `take_screenshot`, `list_network_requests` for the issue endpoint, JSON snippet.

### TC-02 (blocker) — Issue still carries aiType + aiSessionId after task is deleted
- Preconditions: TC-01 succeeded for the same issue/task pair.
- Steps:
  1. Stop the running task (UI Stop control or `conductor diagnose`-derived task-id with the documented stop path).
  2. Delete the task from the UI (Tasks page or task detail menu).
  3. Refresh the issue (UI re-fetch and `curl /api/issues/<issueId>`).
- Expected: the issue payload still exposes the same `aiType` and `aiSessionId` as in TC-01. The fields must not be cleared, blanked, or removed when the underlying task row is deleted.
- Severity if missing: **blocker** — primary acceptance criterion of the requirement.
- Evidence: pre/post network captures of `GET /api/issues` and `GET /api/issues/<issueId>`, screenshots of issue card both before and after delete.

### TC-03 (major) — Issue list response is consistent with issue detail
- Preconditions: TC-02 done.
- Steps:
  1. `curl /api/issues` (or capture the list call from the UI) and locate the issue.
  2. Compare its `aiType` / `aiSessionId` (and any nested linked-task echo) with the detail endpoint.
- Expected: list and detail agree; if one carries the fields, the other carries the same values.
- Severity if mismatch: **major** — surfaces would disagree, breaking traceability in list views.
- Evidence: side-by-side JSON snippets.

### TC-04 (major) — UI exposes the retained traceability
- Preconditions: TC-02 done.
- Steps:
  1. Open the issue in the UI after the linked task was deleted.
  2. Inspect the issue card / detail for any visible AI-type label and AI session reference (badge, tooltip, copyable id, or Open-task entry).
- Expected: the UI surfaces enough of `aiType` / `aiSessionId` for the user to "trace back" — at minimum a non-empty agent-kind label and the session id (or a deterministic affordance to copy/inspect it).
- Severity if missing: **major** — API retention without UI surface defeats "方便后续回溯".
- Evidence: `take_screenshot`, `take_snapshot` of the issue UI; relevant DOM nodes.

### TC-05 (minor) — Same retention after a hard refresh / navigation
- Preconditions: TC-02 done.
- Steps:
  1. Hard reload the issues page; navigate away and back.
- Expected: `aiType` / `aiSessionId` still present (i.e. retention is persisted, not just in client memory).
- Severity if missing: **major** if values reappear blanked after reload (would imply server is the regression).
- Evidence: network capture after reload.

### TC-06 (minor) — User boundary
- Preconditions: TC-02 done; access to a second account is optional. If only one account is available, mark inconclusive.
- Steps:
  1. Sign in as user B; attempt to read user A's issue via `/api/issues/<issueId>`.
- Expected: 401/403/404 (not leaked). Out of scope for this requirement but a quick sanity check.
- Severity: **minor** for this round; unrelated to the retention requirement.

## Risk areas explicitly probed

- Data consistency: fields persist past row deletion of the foreign-key target (the task).
- API consistency: list vs. detail return identical retention fields.
- UX: traceability is reachable from the issue UI without resurrecting the task.
- Regression: prior `frontend-issue-linked-task-remains-openable-after-kill-20260421.md` only covered killed/completed; deletion is the harder cliff.

## Exit criteria

- TC-01 and TC-02 must pass for a `passed` conclusion.
- If TC-01 passes but TC-02 fails, the round is `failed` and a P0 bug ticket must be filed under `claw/issues/`.
- TC-03/TC-04 failing without TC-02 failing → `passed_with_known_issues`, with P1 bug filed.
- TC-05/TC-06 failing alone → `passed_with_known_issues` with P2.
