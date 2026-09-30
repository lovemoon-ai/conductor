# Issue: `issue create --status doing` created an issue that never started

## Symptom
An issue created with `--status doing` had no task, and `issue start` on it did
nothing. Deleting a doing issue's task left it in the same stuck state.

## Root cause
The PATCH route spawns a task only on a transition *into* doing. The web always
creates `todo`, so the create route never had to enforce that.

## Fix
`POST /api/issues` rejects `status: doing` with a 400 ("create it as todo, then
start it"), and the CLI offers only `todo|done` on create. An explicit
`status: doing` PATCH on a doing issue that has no task now spawns one. A
task-count check inside the transaction stops two concurrent starts from both
spawning a task.

## How to avoid next time
State machines whose transitions carry side effects must be enforced by the
server on every entry point, including create.
