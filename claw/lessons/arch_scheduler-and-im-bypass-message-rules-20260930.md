# Scheduled and IM (Feishu) messages bypassed the persistent-round rules

## Symptom
A scheduled message or a Feishu message to a persistent task whose round had
ended was appended to the ended round instead of starting a new one. During the
summary it would have been delivered mid-summary.

## Root cause
The scheduler and channel service called `appendUserMessageToTask` directly.
The round logic from 6718abf lived only in the `/messages` route.

## Fix
One server helper, `deliverUserMessage` in
`web/src/lib/tasks/deliver-user-message.ts`, applies all the send rules.
`/messages`, the scheduler and the channel service use it. It sits outside
`task-ingress-service.ts`, so there is no import cycle with
`persistent-round.ts`. The scheduler skips a run (it does not fail) while a
summary is pending. IM users get the rejection text as a reply instead of a
webhook 500.

The scheduler only lets a not-running persistent task through to start a round
when its status is round-idle (`ROUND_IDLE_STATUSES`: completed/killed/unknown)
and the schedule does not have `stopWhenTaskNotRunning`. `init` and `killing`
keep the old not-running handling. If the round cannot start or no fire takes
the message (`ROUND_START_FAILED`, `TASK_MISSING_ACTIVE_FIRE_OWNER`,
`TASK_NOT_RUNNING`), the run is treated as `task_not_running`: an interval
skips and a one-shot completes. It is not counted as a failure.

## How to avoid next time
Put a product rule in one function and route every entry point through it. Grep
for direct calls to the low-level primitive.
