# Archiving a task that never got a session leaves it stuck in the archive

- Severity: P2 (pre-existing; archive/unarchive routes unchanged in 0.16.0 except the pty rule)
- Layer: final state
- Found: release QA 0.16.0 (2026-10-01), build a3c240c

## Reproduction
```
conductor task create --project <P> --title t --backend claude      # no --prompt; sessionId stays null
conductor task archive <id>       # "Archived task ..."
conductor task unarchive <id>     # Error: 409 Task missing session binding
```
Expected: either archive refuses (like pty tasks, "Only ai_task can be packed"), or unarchive
restores it. Workaround: `task delete --permanent`.
