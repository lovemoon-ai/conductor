# SQLite rollback journal made concurrent writes time out (P1008 / P2028)

## Symptom
On prod (`/opt/conductor/conductor.db`, 167MB), `POST /api/tasks` and
`POST /api/tasks/[taskId]/messages` often hung or returned 500. Three
concurrent creates failed at 5s / 10s / 15s with
`P1008 Socket timeout` (`createAndDispatchAiTask` → `db.$transaction`,
`task-ingress-service` → `db.$transaction`) or `P2028`. Requests that took
longer than 30s timed out on the client after the server had already committed
the task. That left orphan `running` tasks (arxiv-radar scoring, 2026-10-02/03).

## Root cause
The database ran in `journal_mode=delete`, and nothing in the code set it.
Prisma 6 opens SQLite transactions with `BEGIN IMMEDIATE`, and its
`busy_timeout` defaults to 5s. In rollback-journal mode, a commit has to wait
until every open read has finished. Under heavy load (many fire tasks writing
messages, plus long scans), each writer waited behind readers and the other
writers. After 5s SQLite returned `SQLITE_BUSY`, which Prisma reports as P1008.
Locally, a single 8s read made all 3 concurrent interactive transactions fail
with P1008 at about 5.5s. With WAL, the same 3 transactions committed in about
200ms.

## Fix
`enableSqliteWal()` (`web/src/lib/db.ts`) runs `PRAGMA journal_mode=WAL` at
server boot (`web/server.ts`). The setting is stored in the DB file, so it covers
every pooled connection. Readers and writers no longer block each other.

## Avoid next time
- Any SQLite deployment with concurrent traffic must run in WAL. Check with
  `sqlite3 conductor.db "PRAGMA journal_mode;"`.
- Treat P1008 on SQLite as "database busy", not as a network problem.
- WAL adds `-wal`/`-shm` files next to the DB. Back up with
  `sqlite3 ... ".timeout 30000" ".backup <file>"`, never a plain `cp` of
  `conductor.db` alone.
