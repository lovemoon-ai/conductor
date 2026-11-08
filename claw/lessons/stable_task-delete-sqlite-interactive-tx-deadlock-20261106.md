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

This was reproduced on the 2-core prod host with a throw-away DB in `/tmp`, using the same interactive delete transaction, a second interactive transaction and 8 concurrent writers:

| Configuration | Result |
|---|---|
| Default pool, 2 clients (the prod setup at the time) | P2028 + P1008 almost every round, up to 20 s |
| `connection_limit=1`, 2 clients | every round ok |
| `connection_limit=1`, 3 clients | P2028 + P1008 again |

On a many-core Mac the failure does not reproduce.

## Fix

All changes are in `web/src/lib/db.ts`:

- SQLite URLs get `connection_limit=1` (an explicit value wins). Callers then wait for the connection asynchronously instead of busy-waiting on engine threads.
- The client is cached on `globalThis` in production too. `server.ts` (tsx) and the Next.js bundle each evaluate `db.ts`, and previously production ran **two** clients (`lsof` showed 2 `dev.db` connections). The table above shows that `connection_limit=1` is only safe while the number of clients stays below the number of engine threads, so the process must share a single client.
- `transactionOptions.maxWait` is raised to 10 s. With a single connection, interactive transactions queue for it, and Prisma's default 2 s `maxWait` would fail them under bursts.
- Before enabling the single connection, every interactive transaction was checked: inside a transaction, code uses only `tx` and never the global `db`. Calling `db` inside a transaction would deadlock on the single connection.

A first attempt rewrote task DELETE as a batch `$transaction([...])`. Review rejected it, and it was reverted. Moving the shared-worktree check out of the transaction broke `acquireTaskWorktreeMutationLock`. A restart that commits between the check and the delete could then get its successor's worktree force-deleted. Bulk-deleting a task together with its successor could also leave the worktree uncleaned forever. A lock that serializes a check-then-act sequence must stay in the same transaction as the act.

## How to avoid next time

- Keep exactly one PrismaClient per process. Do not limit the `globalThis` cache to dev mode.
- Never call the global `db` inside a `$transaction(async tx => …)` callback (the single connection would deadlock).
- Treat a P2028 paired with simultaneous P1008s as lock starvation, not slow work. Check the core count of the host before raising timeouts.
- Run concurrency reproductions on a host with prod's core count **and** prod's process topology (number of clients). Multi-core dev machines, and dev mode's cached single client, both hide this bug.
- Review before merging, even into local main.
- After deploy, watch `conductor.log` for P2024 and `Unable to start a transaction` (P2028). Every query now queues behind the single connection.
