# Default project could not pick a global AI backend

## Symptom
Creating a task in the Default project, the "AI backend" dropdown had no "Global"
group, so none of the global AI backends configured in Settings could be chosen.

## Root cause
`CreateTaskDialog` built the Global options only when the project had a code
daemon (`isBoundProject` / merged group). RFC 0041 framed a global backend as
"AI on daemon A, code on project daemon B over `conductor remote`", and the
Default project has no B, so the list was empty. The server likewise rejects
`global_backend` for an unbound project.

## Fix
For the Default project the dialog now lists every global backend (greyed out when
its daemon is offline or no longer offers that backend). Picking one just selects
that daemon and backend, creating an ordinary local task, so no `globalBackend` is
sent and the server needs no change.

## How to avoid next time
When a feature adds a new choice to a shared picker, check every project mode the
picker serves (Default, bound, merged cross-daemon group), not just the one the
RFC was designed around. An empty option list should be a deliberate decision.
