---
"@love-moon/conductor-cli": patch
---

"New task from this" on a different daemon now keeps working on the source
task's files: the new task's AI runs on the chosen daemon and reaches the
source directory (or the same worktree) through the remote MCP tools, with the
remote operating protocol in its first prompt. Moving it back to the daemon
that holds the files makes it an ordinary local task again. Falls back to the
previous behaviour when the source daemon is offline or either CLI is too old.
