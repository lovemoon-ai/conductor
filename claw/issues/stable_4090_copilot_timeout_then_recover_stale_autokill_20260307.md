# stable: recover_stale automatically kills task review after copilot times out (2026-03-07)

## Symptoms
- When the user troubleshoots the online task `d340ff8e-9c5d-4049-8a96-e0618cb4832e`, the task eventually becomes `killed`, and the user side shows a session interruption.
- Before the task is killed, `copilot processing failed: Turn exceeded hard deadline (720s)` is returned multiple times for the same user message.
- After the task is killed, the user sends "Is it killed?" again, and the message enters the outbox, but is no longer consumed by the fire worker.

## Root Cause
- This task uses `copilot` backend, and the online message record shows that the same user message is processed repeatedly, and the 720-second hard timeout is hit continuously.
- `reply_to` in the SDK error message metadata always points to the same user message, indicating that the execution layer has not completed this turn, but is retrying after repeated failures.
- At the same time, the web log shows that the corresponding fire host `conductor-fire-unknown-host-3723821` repeatedly reconnected during that period, and `drained outbox ... attempted=3 delivered=0` continued to appear, indicating that the fire side connection or processing link was unstable.
- The task itself does not have a `stop_task` record, so it is not manually stopped by the user, but more like fire losing effective binding after executing abnormally.
- When the task loses the online fire host, the automatic recovery logic of `GET /api/tasks?recover_stale=1` is processed as "offline timeout task", the task is automatically changed to `killed`, and `execution_host` is cleared.