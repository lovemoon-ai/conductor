# Cross-daemon project merge silently inert in production

## Symptom

User reported that the "merge same-name projects across daemons" feature did
not work in practice: two daemons with a project named `conductor` each
remained as two separate cards in the Project list, never combining into a
single merged group despite both web and CLI being on the latest build.

## Root cause

Two compounding gaps:

1. **Merge predicate was too strict.** `canMergeProjects()` in
   `web/src/features/projects/utils/project-groups.ts` required both
   projects to be git repos AND have non-empty, matching `gitRemoteUrl`.
   Any project pointing at a non-git workspace (e.g. a `/tmp` scratch dir
   common in QA), or a project whose `gitRemoteUrl` had never been
   captured, was forced into a single-member group regardless of
   matching name and distinct daemon.

2. **`gitRemoteUrl` had no backfill trigger.** The PATCH `refresh: true`
   code path in `web/src/app/api/projects/route.ts` exists and works,
   and `useProjectsStore.refreshProject` wraps it on the client. But
   the store action was defined dead — nothing in the UI called it,
   no agent reconnect hook called it. Projects created before the
   merge feature shipped (or while their daemon was offline) sat with
   `git_remote_url IS NULL` forever. Inspecting the dev sqlite DB
   confirmed: the two `conductor` rows the user was looking at had
   `repo_root` and `git_remote_url` both NULL.

The net effect: the data flow that the feature relied on never produced
the data the predicate required, and the predicate was strict enough that
no other path could rescue the merge.

## Fix

Two coordinated changes in one PR; either alone would still leave a real
class of users broken.

### Relaxed merge predicate (`project-groups.ts`)

New rule, in priority order:

- Same `name`.
- Different `daemonHost` (both non-empty). Same-daemon duplicates are a
  data anomaly and stay separate.
- Neither has `mergeOptOut === true`.
- If BOTH have `gitRemoteUrl`, they must match (case-insensitive after
  trim). Single-side or missing-both falls through to "merge".

This keeps the original "don't accidentally fuse two unrelated git repos
that share a folder name" safety net active whenever the data is rich
enough to use it, while letting legacy and non-git rows benefit from the
feature.

### Daemon-reconnect backfill (`web/src/lib/projects/backfill.ts`)

New module called from `agent-gateway.ts` on every WebSocket connect
(after capability check). It:

1. Scans `projects WHERE userId = ? AND daemonHost = ? AND
   workspacePath IS NOT NULL AND gitRemoteUrl IS NULL AND
   hiddenAt IS NULL` (idempotent filter — already-filled rows are
   never re-scanned).
2. For each row, calls `validateProjectBindingWithDaemon()` which
   sends the existing `validate_project_path` RPC; daemon runs
   `ProjectContext.snapshot()` which already normalizes
   `git config --get remote.origin.url`.
3. Writes back `gitRemoteUrl` (plus refreshed `repoRoot`,
   `worktreeBranch`, `lastCommit`, `fileCount`) **only when the daemon
   actually returned non-null values** — never blanks existing data.

Design constraints baked in:

- `void` invocation from agent-gateway so backfill never blocks agent
  registration or outbox draining.
- `Map<userId+host, Promise>` dedups concurrent runs (e.g. WS flapping).
- `MAX_PROJECTS_PER_RUN = 50` + 200ms inter-RPC delay to avoid hammering
  a freshly-rebooted daemon.
- `ProjectBindingValidationError` (e.g. `workspace_not_found`) is
  logged + skipped, NOT propagated — a workspace that moved on the
  daemon's filesystem shouldn't wipe DB state.
- Prisma `P2022` on the `gitRemoteUrl` column is caught and turned into
  a no-op + warn, so the path works on databases that haven't run the
  merge-columns migration yet.

## How to avoid next time

- **A store action without a caller is dead code.** When introducing
  a `refreshFoo` / `syncFoo` capability, also add the trigger (UI
  button, lifecycle hook, or scheduled job) in the same PR. If there
  is no trigger, the feature only works for users lucky enough to
  encounter the right edge case.
- **Strict predicates need a data-quality story.** When a merge /
  matching rule depends on a derived field, document AND code up
  how that field gets populated for historical rows. "Newly created
  rows are fine, old rows need to be migrated by hand" is rarely an
  acceptable UX, especially for features that promise something
  visible like "merge same-name projects".
- **Verify with real DB rows, not unit fixtures.** The unit tests for
  `canMergeProjects` were green throughout, but they all used a
  fixture that had `gitRemoteUrl` set. The bug only showed up when
  inspecting actual sqlite rows from a user's dev DB. For any feature
  whose behaviour hinges on a specific field state, add at least one
  test where that field is the realistic legacy value (here: `null`).
- **Pick the cheapest "every user touches this" trigger.** Daemon
  reconnect is a natural pulse: it happens on every restart, every
  config-file swap, and on every network blip. Hooking backfill there
  costs nothing for the user, beats UI buttons that require remembering
  to click, and beats batch jobs that require operator action.

## Verification

- `cd web && pnpm test:run` — 125 files / 980 tests pass.
- Targeted run on `src/lib/projects/backfill.test.ts` +
  `src/features/projects/utils/project-groups.test.ts` — 23/23 pass,
  covering: null-side merge, non-git merge, same-daemon refusal,
  gitRemoteUrl mismatch refusal, dedup of concurrent runs, skip on
  daemon error without wiping data.
- End-to-end check (run by the operator after merge): start the
  daemon, watch `[project-backfill] start: ...` and
  `[project-backfill] updated project=...` lines in the server log
  to confirm the legacy NULL rows on this machine get filled.
