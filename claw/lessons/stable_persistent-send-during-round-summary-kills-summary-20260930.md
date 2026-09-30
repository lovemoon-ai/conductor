# Persistent task: a CLI send or insert during the end-of-round summary killed the summary

## Symptom
After "End round", the AI writes the rolling summary. A `conductor task send`
in that window started round N+1 right away, which stopped the fire mid-summary,
so the summary was lost. `conductor task insert` interrupted the summary reply.
The web composer disables send and insert while the summary is pending.

## Root cause
Commit 6718abf made `/messages` start a new round whenever `roundEndedAt` is set.
The "summary still pending" check (`isRoundSummaryPending`) existed only in
`ChatView`. The insert route knew nothing about persistent rounds.

## Fix
`startRoundIfPersistentIdle` in `web/src/lib/tasks/deliver-user-message.ts`
returns 409 `round_summary_pending` when the task is running, has a
`roundEndMessageId`, and either the runtime state is still replying to it or no
non-user message with `metadata.reply_to` pointing at it exists yet. `/messages`
and `/insert` both use it. On an idle round, insert starts the new round
instead of interrupting anything.

## How to avoid next time
When the server takes over a client rule, move every guard the client puts
around it, not just the happy path.
