# CLI: unknown flags only warn; the request is still sent (exit 0)

- Severity: P2 (pre-existing, same on 0.15.2)
- Layer: CLI argument handling
- Found: release QA 0.16.0 (2026-10-01), build a3c240c

## Reproduction
```
conductor project create --name foo --workspace /tmp/x --create-workspace   # typo for --workspace-path
```
Observed: prints `Unknown argument: workspace`, then creates (or, if the cwd is already a
project, renames) a project whose workspace is the **cwd**, exit 0. Same for
`task create/send/rename`, `settings ...` with any unknown flag.

Expected: like `issue ...` and `daemon list` — `Error: Unknown argument`, exit 2, no request sent.

## Notes
The 0.16.0 issue-arg fix (lesson `misc_cli-issue-arg-choices-ignored-20260930`) made `issue`
strict; the other command groups still are not. If fixed as a user-hit bug, add a lesson under
`claw/lessons/`.
