# UI: Resuming a session as a new user dead-ends on "no project bound"

- Date: 2026-09-05
- Type: ui
- Area: `web/src/features/tasks/components/ResumeSessionPanel.tsx`, `cli/src/daemon.js`

## Symptom

A brand-new account (first daemon launch, no projects bound yet) opens
"Resume a computer session" on the web app, picks a local claude/codex/kimi
session, and the panel refuses to continue: the session has no matching
project and there is nothing to attach it to ("Bind a project on the daemon
first"). The user expected the session to fall back to the Default Project,
which is what every other create-task path does, so the feature is unusable
until they go bind a project by hand.

## Root cause

Three layers, all around the default project:

1. `ResumeSessionPanel` matched selectable projects with
   `project.daemonHost === host`. The default project is host-agnostic
   (`isDefault: true`, no `daemonHost`), so a fresh account — whose only
   project *is* the default one — got an empty list and the dead-end notice.
   Fixed on a branch by 6d06f5a, **but that commit never landed on
   `origin/main`**, so production still ran the broken filter. The report was
   against the deployed build, not the branch.
2. Even with 6d06f5a, the panel only *offered* the default project in a
   dropdown that starts at "Select a project…", with Resume Session disabled
   until the user picks. The documented design is that an unmatched session
   binds to the default project automatically.
3. The dead-end notice was also the panel's rendering of "the projects list is
   empty" — which is equally true while `GET /api/projects` is in flight or
   after it failed. A transient projects-fetch failure therefore told the user
   to go bind a project on their daemon, which fixes nothing.

Separately, the daemon's `create_task` path had no session-cwd fallback: with
no `launch_config.cwd` (the server sends none for the default project, which
has no workspace path) and no bound project path, `handleCreateTask` created a
scratch run dir under `WORKSPACE_ROOT` and spawned fire there. Resume still
worked — fire's `bootstrapResumeContextForFire` chdirs into the session's own
cwd, and claude/codex session lookup scans the whole session store rather than
the current directory — but `conductor.log` and the task dir ended up detached
from the real workspace. `resolveRestartCwd` already had exactly this fallback;
only the create path was missing it.

## Fix

- `ResumeSessionPanel` resolves an unmatched session's project to the user's
  default project unless they pick another one, and the dropdown reflects the
  preselection instead of an empty placeholder.
- The panel distinguishes "projects still loading" / "projects failed to load"
  (with a Retry) from "no project is selectable", and re-fetches projects once
  when it opens on an empty list, so a cold or failed store cannot masquerade
  as a binding problem.
- `cli/src/daemon.js` extracts `resolveSessionResumeCwd()` out of
  `resolveRestartCwd` and uses it in `handleCreateTask` as well: a resumed task
  with no configured or bound path now runs in the session's own cwd, falling
  back to the scratch workspace only when the session cannot be located.

Covered by `ResumeSessionPanel.test.tsx` (9 cases: default fallback, manual
override, cwd-matched project, no-default account, no selectable project,
loading, fetch failure + retry, listing failure + retry, linked-session jump)
and two `cli/test/daemon.test.js` cases (session cwd is used and no scratch dir
is created; unresolvable session still starts in the scratch workspace).

## How to avoid next time

- New-account (zero bound projects) state is a first-class case for any new
  create-task surface. Test it with a projects list that contains *only* the
  default project — that is what every new user has.
- "Offer it in a dropdown" is not the same as "bind it by default". When the
  design says a fallback is automatic, preselect it and keep the primary
  action enabled.
- An empty client store is not evidence of an empty server state. Any "you
  have no X" copy needs the loading and error branches split out, or it will
  send users to fix the wrong thing.
- When adding a fallback chain to one entry point (restart), check the sibling
  entry point (create) — they diverged here for months.
- A verified fix on a feature branch is not a shipped fix. When a user reports
  a bug we believe is already fixed, check `git merge-base --is-ancestor <fix>
  origin/main` (and the deployed build) before assuming a regression.
