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

## How to avoid next time
Put a product rule in one function and route every entry point through it. Grep
for direct calls to the low-level primitive.
