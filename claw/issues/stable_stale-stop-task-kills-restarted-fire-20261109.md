# Stale stop_task kills the first in-place restart after stopping a disconnected fire

- Severity: P2 (minor). Needs a wedged or disconnected fire plus a stop issued while it is disconnected. Restarting a second time works.
- Layer: final state / outbox delivery
- Found: QA for the 0.18.0 candidate, 2026-11-09, build 54a0ce24 (web dev server + RC CLI from `npm pack`, tmux-mode daemon `qa-dev-daemon-tm`)
- Status: reproduced twice

## Reproduction
1. Use a daemon with `fire_tmux_mode: true`. Create a task and let it reply.
2. Freeze the fire's node process (`kill -STOP <pid>`). After about 30 s, `conductor diagnose` shows `bound_agent_connected=false` and `assigned_agent_connected=false`.
3. Stop the task: click the status pill twice, which sends `PATCH {"status":"killed"}`. It stays `killing` for 2–5 min, then the lazy stale recovery sets it to `killed`.
4. Restart in place from the `Stopped` pill. `POST /restart` returns 200. The daemon logs "Replacing disconnected fire" (the 0.18.0 fix) and spawns a new tmux fire.

## Expected vs observed
- Expected: the new fire attaches and serves the task, and the task becomes `running`.
- Observed: the new fire logs `Received stop_task for <task> (stopped_from_app); stopping conductor fire` within 1 s of attaching, then exits with code 0. The task goes back to `killed`. The UI shows no error, so the restart looks like it did nothing.
- A second restart works, and the task replies.

## Suspected cause
The `stop_task` sent while the fire was disconnected stays undelivered. It is handed to the next fire that attaches to the same task id, which is the restarted one. A restart should drop or supersede stop commands that predate it.

## Evidence
`claw/issues/tmp_release-qa-0180-20261109/` (local only): `tmp_evidence/R2_*.png`, `R2c_*`, `R2c_diag_after_restart.json`, and the fire log `/private/tmp/tmp_qa_workspace_tm/conductor.log` from 08:54:00 and 09:05:17.

## Notes
This is not a regression. Before 0.18.0, restarting in this state was refused outright ("task already active in tmux session"). This is the same incident shape as `claw/lessons/stable_fire-wedged-ws-handshake-blocks-restart-20261109.md`, where the user had pressed Stop first. Whoever fixes it should add a `claw/lessons/` entry, as CLAUDE.md requires.
