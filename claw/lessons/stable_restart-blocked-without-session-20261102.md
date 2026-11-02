# Restart blocked when a task has no AI session

Task: `2122d465-9e75-4baf-be87-89f57fcc6443` ("operator 需求经理"; persistent, codex-sol on ruofo, remote worktree on ubuntu).

## Symptom
Restart on the killed task always failed with `409: Task missing session binding`.

## Root cause
- When a persistent task starts a new round (`persistent-round.ts`), it sets `sessionId: null`, because each round runs in a fresh AI session.
- Round 13's fire died about 25s after launch (`Backend request failed: This operation was aborted`). It had not reported a session yet, so the task ended up `killed` with no `sessionId`.
- The restart route rejected every request when `sessionId` was empty. That left the task unrecoverable through restart: only starting another round would bring it back.

## Fix
`POST /api/tasks/:id/restart`: when the task has no session, an in-place restart now queues a `create_task` for the same task id (`replace_existing_fire: true`, the same as a persistent round). This starts a fresh session. Its first message is the transcript-handoff prompt, wrapped in the remote worktree/workspace bootstrap when the task has one. The task is also rebound to the restart daemon.

Session refresh and fork (`new_task`) still require a session. They return 409 with a clearer message. Reclaim is skipped when there is no session.

## Avoid next time
Anything that clears `sessionId` creates a window where the session can stay missing forever. A recovery path must not require state that a normal lifecycle step is allowed to leave empty. When you add a precondition, check which paths can leave it unset.
