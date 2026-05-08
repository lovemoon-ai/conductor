# Pre-release notes — Issue retains aiBackendType / aiSessionId after task delete

- Date filed: 2026-05-08
- Source change: commits `26d1946`, `ebe82df`, `1fc4e6b` (latest on `main`: `732b717`)
- QA round: `claw/issues/issue-retain-ai-type-and-session-after-task-delete-20260508/test_report_round_2.md`
  (conclusion `passed_with_known_issues`, 0 P0, 0 P1, 1 P2)

Before this ships to prod, walk through the items below.

## 1. Data migration & boot-time backfill

- [ ] Verify the schema migration that adds `ai_backend_type` / `ai_session_id`
  on the `issue` table is online-safe on prod (nullable, default `null`, no
  long table lock). Inspect the generated SQL before applying.
- [ ] Estimate how long the boot-time backfill will take on prod data
  (`[issue-ai-session-backfill] backfilled N values from existing tasks`).
  Local dev had 5 issues and finished sub-second; prod scale could noticeably
  delay `/ready`. If it does, move backfill out of the boot path or make it
  async + bounded.
- [ ] Confirm the backfill is idempotent and concurrency-safe across HA
  instances. Rolling deploy or multiple replicas must not double-write or
  fight over the same rows.
- [ ] Add (or confirm) a one-shot metric / log line that operations can use to
  confirm the backfill ran and how many rows it touched. Today the only
  signal is the `[issue-ai-session-backfill] ...` log line.

## 2. Business semantics that need an explicit decision

The PRD only says "retain". The code now has to choose; pin the choice down
before shipping so we don't ship inconsistent behavior.

- [ ] Once `aiBackendType` / `aiSessionId` are written on an issue, are they
  **immutable** or do they get **overwritten** by a later task on the same
  issue (restart, kill+retry, deleted+new)?
- [ ] If a task is restarted and produces a **new** session id, does the
  issue keep the original or update? "回溯" semantics depend on this.
- [ ] If multiple tasks are linked to the same issue over time, which one's
  fields end up on the issue? First? Last? Latest non-null? Document and
  add a focused regression test.

## 3. Mixed-version risk

- [ ] Old daemon + new server: confirm an old daemon that does not report
  `backend_type` / `session_id` does not break the new server's write path.
  At worst the issue stays null (acceptable). The server must not 500.
- [ ] New daemon + old server: confirm new daemon does not refuse to talk to
  an older server that has not yet learned the new fields.
- [ ] Add a mixed-version case to `claw/sop/05_qa.md §5` so future rounds
  cover this combination.

## 4. Privacy / user-boundary regression

- [ ] **TC-06 (user boundary) was inconclusive in QA round 2** — only one
  account was available. Before shipping, run a multi-account check:
  user A's issue with `aiSessionId` populated must not be reachable by
  user B via `/api/issues` (list) or `/api/issues/<id>` (detail).
- [ ] Decide whether `aiSessionId` is PII-grade or just an opaque trace key.
  The current code treats it as plain text; confirm log retention / export
  flows are OK with that.

## 5. Known issues that interact with this feature

- [ ] `claw/issues/stable_daemon_ws_10s_reconnect_loop_20260424.md` — the
  reconnect loop kills tasks before codex / claude can emit a session id,
  so for affected users the issue ends up with `aiBackendType` populated but
  `aiSessionId=null` permanently. Until that bug is fixed, prod users on
  flaky links will see degraded "回溯" coverage. Consider gating launch on
  that fix or pre-prepare a metric for "% of doing-state issues with null
  aiSessionId" so support can see the impact.
- [ ] `claw/issues/frontend-issue-linked-task-remains-openable-after-kill-20260421.md`
  is in the same area and still open. Ship together if possible to avoid a
  split UX.

## 6. UI gap (P2 from QA round 2)

- [ ] On the issues board, the IssueCard's AI-type badge disappears once the
  linked task is deleted, even though `aiBackendType` and `aiSessionId` are
  still on the issue. Either: (a) keep rendering the badge from the
  issue-level fields when `linkedTask` is null, or (b) surface the values in
  the IssueDetailsDialog with a copy-to-clipboard control. Without one of
  these, the "方便后续回溯" promise is only met at the API surface, not for
  end users.

## 7. Rollback

- [ ] Code rollback to before `a40ba9c` is safe: the new columns are nullable
  and pre-feature code ignores them. **Do not roll back the schema** — leave
  the columns in place so the next release can re-use them.
- [ ] If the boot-time backfill becomes a problem (long boot, lock contention),
  hot-fix path is to ship a flag that disables the backfill on boot while
  keeping the write-path persistence working for new issues.

---

When this note is fully addressed (or each item explicitly accepted as
out-of-scope), delete this file as part of the release per
`claw/sop/06_release.md`.
