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

- The restart route now always copies the source's `secondProjectId` to the
  successor. "New task from this" continues the same work, so it stays in the
  same project, just as it keeps the source's labels.
- For the cross-daemon remote binding, when the source's own project is not
  bound on the source daemon, the route uses the display project bound there.
  It takes that project's id and repo root, and its workspace path when the
  source has no cwd.

## Prevention

A task's project has two fields: `projectId` is where the task is filed and
`secondProjectId` is where it is shown. Any operation that derives a new task
from an old one must copy both. Don't infer which project holds the code from
transient metadata like `globalBackend`, which can be dropped while the
project ids stay.
