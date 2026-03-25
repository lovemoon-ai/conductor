# Fire restart must stay on the original execution daemon

## Symptom
A task started from `conductor fire` could appear as `killed` in the app after the fire process exited, but restarting it from the app failed later for both in-place restart and new-task restart.

## Root cause
The restart flow treated stopped fire tasks as portable and reassigned them to an arbitrary online daemon. But the recoverable session state still lived on the task's original execution daemon, so picking a different daemon broke restart.

## Fix
Use the task's real `executionHost` as the only restart daemon for stopped fire tasks. If that original execution daemon is missing or offline, return a 409 instead of silently picking another daemon. The app UI now follows the same rule.

## How to avoid next time
For any restart/resume/handoff flow, distinguish between the display host and the host that actually owns runtime state. Session-bound recovery must stay sticky to the true execution host unless the underlying bridge explicitly guarantees portability.
