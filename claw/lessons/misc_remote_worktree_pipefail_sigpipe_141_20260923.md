# misc: remote-worktree prompt made read-only `| head` pipes exit 141 (2026-09-23)

## Symptoms
- In remote-worktree tasks, read-only commands such as `bash -lc "set -euo pipefail; rg ... | head"` came back from `conductor remote exec` with exit code 141, even though their output was complete.
- The model treated 141 as a failure. One session hit this 4 times and re-ran one command, and every extra round re-read the whole context (median 287k tokens).

## Root Cause
- The bootstrap prompt (`web/src/lib/tasks/remote-worktree.ts`) said "Start every script with `set -euo pipefail`".
- `head` exits once it has its lines, so the upstream `rg`/`sed` gets SIGPIPE (128+13 = 141). With `pipefail` set, that becomes the pipeline's exit code, and `remote exec` passes it through verbatim.

## Fix
- Reworded the same prompt line: use `set -euo pipefail` for multi-step write/build scripts, and leave it off read-only `... | head` queries. The rule count stays the same.

## Prevention
- A blanket shell rule in an agent prompt applies to every command the agent writes. Before adding one, check how it behaves on the most common read-only pattern (`| head`, `| grep -q`), not only on the build script it was meant for.
