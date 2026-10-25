# "New task from this" lands in the default project

## Symptom

Running "New task from this" on a humanoid-deploy task (`e2521ebb`) to
another daemon created a successor that appeared under the **default**
project, not under humanoid-deploy. The successor's remote worktree was also
bound to the default project (`remoteWorktree.projectId` = default), even
though the code lives in humanoid-deploy on `ubuntu`.

## Root cause

The source task was filed on the unbound default project and displayed under
humanoid-deploy through `secondProjectId`. That is how RFC 0041 files a
global-backend task. Its AI had since moved to the code's daemon
("homecoming"), and a homecoming deletes `metadata.globalBackend`. The two
project ids stay as they were.

The restart route had two gaps:

1. It copied `secondProjectId` to the successor only when the source still
   had `metadata.globalBackend`. A homecoming task, or a task moved
   display-only, lost its display project. The successor fell back to its
   real `projectId`: the default project.
2. When the successor ran on another daemon, the route bound it to the source
   directory using `project.id` / `project.repoRoot`. Here that project was
   the unbound default project, so the remote worktree pointed at a project
   with no daemon or repo. A later "new worktree" from that successor would
   fail.

## Fix

- The restart route copies the source's `secondProjectId` to the successor
  even when the source has no `metadata.globalBackend`. "New task from this"
  continues the same work, so it stays in the same project, just as it keeps
  the source's labels. There are two exceptions. A display project that no
  longer exists or is hidden is not copied, because the successor would
  vanish from the list. A code move (`code_host`) does not copy a display
  project bound to another daemon, because the work leaves that project's
  machine.
- The route works out once which project holds the source's code on the
  source daemon. Usually that is the task's own project. It is the display
  project only when the task's own project is not bound on the source daemon,
  the display project is, and the source's worktree or cwd lies inside the
  display project's repo. The remote binding of a cross-daemon successor and
  the "new worktree" path both use this project. A homecomed task can
  therefore start a new worktree on its own daemon, and when its daemon cannot
  be reached the user gets the "pick a backend on <code daemon>" guidance.
- When the source has no cwd, the route never falls back to the display
  project's workspace path. A display-only move says nothing about where the
  source's files are.

## Prevention

A task's project has two fields: `projectId` is where the task is filed and
`secondProjectId` is where it is shown. Any operation that derives a new task
from an old one must decide what to do with both. Work out where the code
lives in one place, from the source's actual paths. Don't infer it from
transient metadata like `globalBackend`, which can be dropped while the
project ids stay, or from a display-only field.
