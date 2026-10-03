# Kimi background subagents killed by conductor's 12-minute idle deadline

## Symptom

Found while checking whether the Claude background-subagent bug
(`stable_claude-background-subagents-killed-at-print-wait-ceiling-20261003.md`)
also affects Kimi. On a Kimi Code task, a background subagent that runs longer
than 12 minutes is killed together with kimi, and the turn fails with
`Kimi print turn timed out`.

## Root cause

New Kimi Code CLIs (0.41.0 on h20) are detected as prompt mode, so
`KimiPrintSession` runs one `kimi --prompt ... --output-format=stream-json`
child per turn. By default `kimi -p` uses `print_background_mode = 'steer'`:
after the main agent's turn it keeps the process alive while background tasks
are pending, and their completion starts a new main turn. The wait ceiling is
effectively unbounded. While it waits, kimi writes nothing to stdout or stderr.

`KimiPrintSession` treats a turn with no output for `CONDUCTOR_TURN_DEADLINE_MS`
(default 12 min) as stuck, and SIGTERMs the child. Kimi then closes the
session, and the subagent ends as `task.terminated status:"killed",
stopReason:"Session closed"`.

Reproduced on h20 with the deadline set to 60 s and a 150 s subagent:
- Raw `kimi -p`: silent from 11.0 s to 171.8 s, then `BACKGROUND_DONE SUBAGENT_FINISHED`.
- Through `KimiPrintSession` 0.15.0: `turn_timeout` at 73.8 s (13.8 s + 60 s), and
  the subagent was killed.

## Fix

When a tool result reports a detached launch (it contains the lines
`task_id: …` and `automatic_notification: true`, which Kimi emits for
background `Agent`, `Bash` and question tasks), the turn is marked, and from
then on the idle deadline no longer kills the child. The turn ends when kimi
exits after its follow-up turn. Interrupt and session close still stop it.

Verified on h20 with a patched copy of the 0.15.0 dist and the same 60 s
deadline: no kill at 70 s, `BACKGROUND_DONE SUBAGENT_FINISHED` at 175 s, and
the turn completed normally.

Known limit: the turn stays "running" until every background task finishes,
so user messages queue behind it. Returning at the end of the main agent's turn,
as the Claude fix does, needs a turn-end signal that Kimi's stream-json does not
emit.

## How to avoid next time

- An idle or activity deadline must account for silences the CLI produces on
  purpose, such as waiting on background work. Check what each CLI prints, if
  anything, while it waits on background tasks.
- When fixing a lifecycle bug in one provider, check the other providers'
  process models (persistent vs per-turn) for the same failure.
