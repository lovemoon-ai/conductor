# Messages sent during an AI session refresh went to the session being replaced

## Symptom
The web blocks send and insert while "Refresh session" is in progress. A CLI
send or insert in that window was delivered to the old session.

## Root cause
Only the web knew about the refresh (local `restartPending`). The server kept no
state for it.

## Fix
The refresh already writes a `refresh_session` agent-outbox row. The row stays
`pending`/`sent` until the daemon acks, or it times out after 60s. Send and insert
now return 409 `restart_pending` while such a row exists
(`assertNoSessionRefreshPending` in `web/src/lib/tasks/deliver-user-message.ts`).
Interrupt is not gated. An interrupt during a refresh loses nothing.

## How to avoid next time
Look for state the server already keeps before you add a new flag.
