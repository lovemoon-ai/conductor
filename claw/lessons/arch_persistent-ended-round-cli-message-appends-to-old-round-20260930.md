# Persistent task: CLI message after "End round" went into the ended round

## Symptom
On a persistent task, after ending round N (and before starting round N+1),
a message sent with `conductor task send` (e.g. by an AI in another task) was
appended to the ended round instead of starting round N+1. Sending the same
text from the web composer correctly started a new round.

## Root cause
The "ended round → new round" decision lived only in the web client:
`ChatView` checks `persistent.roundEndedAt` and calls `POST /tasks/:id/rounds`.
The CLI (and any other API caller) posts to `POST /tasks/:id/messages`, which
never looked at the persistent state and just delivered the message to the
still-alive fire of the ended round.

## Fix
`POST /api/tasks/:id/messages` now checks the persistent state: a `role: "user"`
message to a persistent task whose round has ended calls `startPersistentRound`
and returns the new round's user message. Non-user messages (the fire's own
output, e.g. the round summary) are unaffected. Attachments are rejected with
409, same as the web composer.

## How to avoid next time
Product rules about *what a message means* (new round, reject, queue) belong on
the server route, not in one client. When a web UI branches on task state
before calling an API, check that the CLI/SDK path to the same action goes
through the same branch.
