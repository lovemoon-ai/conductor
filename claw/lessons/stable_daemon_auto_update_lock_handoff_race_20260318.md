# stable: lock handoff race causes background process loss when daemon auto-update restarts (2026-03-18)

## Symptoms
- The background daemon attempts to restart itself after auto-update is successfully installed.
- When the new daemon starts, it first reads the old `daemon.pid`, determines that "there is already a daemon running" and then exits directly.
- The old daemon then exits and clears the lock, with the end result being that there is no daemon running.

## Root Cause
- During the restart process, the old daemon spawns the new daemon first, and then exits by itself.
- The lock file only saves the old pid and provides no "this is a legal handover" semantics.
- New daemon cannot distinguish:
- True repeat launch
- Controlled takeover in auto-update scenario

## Fix
- When auto-update restarts, the old daemon first writes the lock with:
- `handoff_token`
  - `handoff_from_pid`
  - `handoff_expires_at`handover status.
- If the token/pid matches when the new daemon starts, it is allowed to take over the lock instead of exiting directly.
- Still retain the strict rejection logic during normal repeated startup to avoid split-brain.

## Prevention
- In any scenario where "the old process pulls up the new process and then exits", an explicit handoff protocol must be designed and cannot just rely on the pid file.
- When it comes to lock/leader election/single instance daemon process, the test should cover:
- Restart normally
- failed restart
- lock takes over
- Remains of old lock