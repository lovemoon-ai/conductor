# Issue: `issue start --backend X` silently ignored X on restart

## Symptom
For an issue with a linked task, `issue start --backend claude` restarted the
task on its old backend but stored `backendType: claude` on the issue.
`--global-backend` in the same situation was rejected with a 409.

## Root cause
The restart path always resumes the linked task in place (same backend, same
daemon) and never looked at the requested backend or daemon.

## Fix
The PATCH route returns 409 when a restart request names a backend or daemon
that differs from the linked task's. The web never sends one on restart.

## How to avoid next time
When a request option can't be honored on a code path, reject it there, as the
sibling options already do. Never drop it silently.
