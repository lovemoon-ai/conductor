# Task delete fails with 500 (SQLite interactive-transaction deadlock)

## Symptom

Deleting a task from the web UI often failed (HTTP 500) while archiving the same task right afterwards always worked. Prod nginx showed DELETE 500 on 10-28, 11-02 (×2), 11-03 and 11-05; each time the user then archived the task successfully a few seconds later. `conductor.log`:

```
P2028 Transaction already closed ... timeout 5000 ms, however 5294 ms passed
  at src/app/api/tasks/[taskId]/route.ts:1427   (delete's db.$transaction(async tx => …))
P1008 Socket timeout  at agentOutbox.updateMany (/api/agent/events, stop ack)   ← same moment
```

The tasks had only 9–12 messages, so the transaction was not doing much work.

## Root cause

1. Deleting a live task sends `stop_task`. When the agent acks, `commitTaskStopAck` resolves the in-memory waiter first, so the delete route immediately opens its interactive transaction, and then the ack handler writes `agentOutbox`. Two writers start at once, plus the usual background writes (auth, runtime-status, outbox processor).
2. The interactive transaction takes SQLite's write lock with its first statement and keeps it across several JS round-trips.
3. While Prisma's native engine waits for that lock it busy-waits, and the waiting occupies an engine worker thread. There is one worker thread per core, and the prod host has 2 cores.
4. Two waiting writers occupy both threads, so the next statement of the transaction holding the lock can never run. The transaction times out after 5 s (P2028), and the waiting writers time out too (P1008). The same problem appears elsewhere in the log as P2028/P1008 from `create-ai-task`, `deliver-user-message` and the auth middleware.

Archive never failed because it uses no interactive transaction, and by the time the user archives, the agent has already stopped, so no ack write competes for the lock.

This was reproduced on the 2-core prod host using a throw-away DB in `/tmp`. An interactive transaction alongside 3–4 concurrent writers failed with P2028 every round. The same work as a batch transaction, or with `connection_limit=1`, succeeded every round. On a many-core Mac the failure does not reproduce.

## Fix

- Task DELETE (both the live path and the `?permanent=1` archived path) now runs its reads first and then does every write in one batch transaction, `db.$transaction([...])` (helper `deleteTaskRowsInBatch`). A batch runs entirely inside the engine and holds the write lock for milliseconds without returning to JS. The shared-worktree check now runs as a plain read just before the batch.
- `src/lib/db.ts` adds `connection_limit=1` to SQLite URLs (an explicit value wins). With a single connection, callers wait for the connection asynchronously and do not busy-wait on engine threads, so no route can hit this deadlock. Before enabling it, every interactive transaction was checked: inside a transaction, code uses only `tx` and never the global `db`. That matters because calling `db` inside a transaction would deadlock on the single connection.

## How to avoid next time

- On SQLite, prefer batch `$transaction([...])` and keep interactive transactions short. Never call the global `db` inside a `$transaction(async tx => …)` callback (the single connection would deadlock).
- Treat a P2028 paired with simultaneous P1008s as lock starvation, not slow work. Check the core count of the host before raising timeouts.
- Run concurrency reproductions on a host with the same core count as prod. Multi-core dev machines hide this class of bug.
