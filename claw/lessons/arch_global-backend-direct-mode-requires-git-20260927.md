# Global AI backend rejects non-git project directories

## Symptom
Creating a task with a global AI backend (e.g. `claude @ l20-yy`) on a project
whose directory is not a git repository failed with:
`Project "loco-manip" on daemon ubuntu is not a git repository`.

## Root cause
`resolveGlobalBackendMount` always called `resolveRemoteTarget`, which requires
`repoRoot` (only set for git projects) because it also computes a worktree
`baseRef`. That helper was built for RFC 0038 remote worktrees and was reused
for RFC 0041 direct mode, where the AI edits the project directory in place
and needs no git at all.

## Fix
Only resolve the git target when a remote worktree is requested. In direct
mode, build `remoteWorkspace` from the project itself, using `repoRoot ??
workspacePath` as the jail root for the remote_* MCP tools (deployed CLIs keep
working because `repoRoot` is still always present).

## How to avoid next time
When reusing a helper across modes, check that its preconditions (here, "is a
git repo") actually apply to every mode. Test the plain-directory case for any
feature that works "like a local task without a worktree".
