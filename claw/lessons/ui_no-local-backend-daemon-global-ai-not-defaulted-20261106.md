# ui: daemon without its own AI backend does not default to a global AI

## Symptom
A project whose daemon declares no AI backends could not get a usable AI in
Create New Task: the AI backend dropdown sat on a disabled "Select a backend"
placeholder even though global AIs (Settings → Global AI backends) could run
the task. "New task from this" on such a daemon was worse: it preselected the
source task's backend (which the daemon does not have) and submitted it.

## Root cause
Both dialogs only defaulted to the code daemon's own backends. Global AIs
were treated as an opt-in alternative and were never the default, even
when they were the only valid choice.

## Fix
- `CreateTaskDialog`: with no local backends, `selectedGlobalBackend` falls
  back to the first enabled global option.
- `RestartTaskControls`: `defaultBackendValue` falls back to the first enabled
  global option before the source task's (unsupported) backend.
- `CreateTaskDialog`: Create stays disabled until a backend is chosen, so a
  daemon with no AI (e.g. the default project's first daemon) cannot submit a
  task with no backend.

## Avoid next time
When a picker merges several option sources, the default has to come from the
first *valid* option across all of them, not only the primary source. Test
the "primary source is empty" case.
