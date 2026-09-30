# `task create --project <uuid>` into a hidden project prints no warning

- Severity: P2 (new in 0.16.0 feature)
- Layer: CLI output
- Found: release QA 0.16.0 (2026-10-01), build a3c240c

## Reproduction
```
conductor project hide <P>
conductor task create --project <P-uuid> --title t --backend claude      # no warning
conductor task create --project <P-name> --title t --backend claude      # Warning: project ... is hidden ...
cd <P workspace> && conductor task create --title t --backend claude     # Warning printed
```
Expected (per lesson `ui_task-into-hidden-project-vanishes-20260930`): every `task create`
whose resolved project is hidden prints the stderr warning. With a raw project id the task
is created silently and does not show in the web task list.
