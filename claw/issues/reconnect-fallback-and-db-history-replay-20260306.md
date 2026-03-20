# reconnect fallback / DB-history replay problem record
Date:2026-03-06

## background
`conductor-fire` currently retains an optional reconnect recovery path:
- `recoverAfterReconnect()` is executed after detecting websocket reconnection
- When the environment variable is `CONDUCTOR_FIRE_RECONNECT_BACKFILL=1`, `backfillPendingUserMessages()` will be called
- `backfillPendingUserMessages()` does not read the real-time message queue, but directly requests the task history `/api/tasks/:taskId/messages`
Related code:
- `<repo-root>/cli/bin/conductor-fire.js`
## Current DB History Replay Behavior
The logic of `backfillPendingUserMessages()` is:
1. Pull the complete message history of the task2. Find the location of the last `sdk/assistant` message3. Treat all subsequent `user` messages as pending4. Call `respondToMessage()` and rerun these messages one by one.
This is "inferential compensation" based on database history, not deterministic delivery based on real-time queue/outbox.

## reconnect fallback What is currently done?
`recoverAfterReconnect()`'s responsibility was originally to handle the recovery after fire reconnection.
Currently it does two things:
1. Optional execution of DB-history replay2. Resend the latest runtime status to the front end
Item 1 is currently off by default and will only be enabled if `CONDUCTOR_FIRE_RECONNECT_BACKFILL=1` is explicitly set.

## Confirmed issues
### 1. Easy to duplicate the real-time message main link
The current main link already has:
- websocket real-time delivery
- local session queue
- server durable outbox / replay

If DB-history replay is added once, it will hit the same message as live queue/outbox, causing repeated execution.
### 2. "The users after the last sdk are considered pending" is just a heuristic and unreliable
This judgment relies on the order in which messages are dropped into the database, rather than on the actual delivery status.
Scenarios where it may misjudge include:
- sdk messages are dropped into the database later than expected
- AI has been processed, but the last sdk persistence failed
- There are multiple intermediate replies, error replies, and systematic synthetic messages in the conversation.
### 3. It is more likely to conflict with session-file modes such as Codex
The Codex is now:
- Enter to go TUI
- Reply text to session file
- Process status via TUI/monitor
Once DB-history replay feeds the same user prompt again, the Codex session will actually receive the same input for the second time, and the impact is more direct than the ordinary single-round text backend.
### 4. The semantics of the debugging switch are unclear
`CONDUCTOR_FIRE_RECONNECT_BACKFILL=1` actually triggers "Replay user messages by database history".
This behavior is risky, but the variable name only reflects the reconnect backfill, which is not enough to clearly inform "possible rerun prompt".

## Current judgment
This mechanism belongs to historical compatibility compensation logic and should no longer be relied upon as a regular recovery path under the current websocket + durable outbox architecture.
The more reasonable proposition at present is:
- User message recovery is subject to server durable outbox
- fire only consumes live queue locally
- When reconnecting, the runtime status will be replayed at most, and the user messages in the DB history will not be replayed.

## Tentative processing strategy
This time, we will record the problem first and will not continue to deal with this logic.
Current recommendations remain:
- Do not enable `CONDUCTOR_FIRE_RECONNECT_BACKFILL`
- Do not use DB-history replay as the default method of failure recovery

## Subsequent options
### Fix A: Completely remove DB-history replay
Benefits:
- The clearest logic
- Avoid repeated prompt execution
- Consistent with durable outbox responsibility boundaries

Cost:
- It is necessary to confirm that all fire backends completely rely on live queue/outbox and no longer require historical compensation.
### Option B: Keep the debug-only manual switch, but explicitly mark the risk
If you don't want to delete it in the short term, you can at least do the following things:
- Change variable names to be more dangerous and clear
- Print high priority logs when triggered
- Only allowed to be enabled in debug/dev mode
- Clearly mark "possible rerun of unfinished user prompt"

## Historical information
- DB-history replay was first introduced on `2026-02-07`
  - commit: `1603ad3d5ad602abedd61f2b6c7bf92d06e9e997`
  - message: `refactor flutter-app with frontend app`
- Reconnect fallback related notes and switches were consolidated on `2026-02-26`
  - commit: `d1b81cdc3eefaa37932a20341812a1b2286ef290`
  - message: `add durable agent reconnect recovery`
