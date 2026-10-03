# SQLite switches to WAL on first boot (merge 881a600)

Starting with this release, `web/server.ts` runs `PRAGMA journal_mode=WAL` at
boot through `enableSqliteWal()` in `web/src/lib/db.ts`. On the first restart
after deploy, prod `/opt/conductor/conductor.db` changes from `delete` to
`wal`. WAL is stored in the DB file, so it stays on for every later boot.
Background is in `claw/lessons/stable_sqlite-rollback-journal-write-timeouts-20261003.md`.

## Before deploy
- Take a backup in the usual way (the old file is still in `delete` mode):
  `sqlite3 /opt/conductor/conductor.db ".timeout 30000" ".backup /opt/conductor/conductor.db.bak-$(date +%Y%m%d%H%M)"`
- The directory holding the DB must be writable by the service user, because
  WAL creates `conductor.db-wal` and `conductor.db-shm` next to the DB file.

## After deploy (`scripts/deploy-prod.sh`)
- `sqlite3 /opt/conductor/conductor.db "PRAGMA journal_mode;"` must print `wal`.
- `ls /opt/conductor/conductor.db*` should list the `-wal` and `-shm` files.
- `grep "\[db\] failed to enable SQLite WAL" conductor.log` must return
  nothing. If the switch fails (for example, the old process still holds the
  DB), the server only logs that warning and stays in `delete` mode. In that
  case, make sure no old `server.ts` process is still running (kill by port
  6152), then restart again.
- Watch `conductor.log` for P1008 / P2028. They should stop. A good check is
  three concurrent `POST /api/tasks` requests, which should each return in well
  under 5s.

## Ongoing (keep after this release)
- **Never back up with a plain `cp conductor.db`.** Committed data can sit in
  `-wal` until a checkpoint. Always use `sqlite3 ... ".backup"`, or stop the
  service before copying all three files together.
- Never delete `conductor.db-wal` / `-shm` while the service is running.
- The `-wal` file can grow under write load and shrinks at each checkpoint;
  this is normal. To shrink it by hand:
  `sqlite3 /opt/conductor/conductor.db "PRAGMA wal_checkpoint(TRUNCATE);"`.

## Rollback
Rolling back the code does **not** take the DB out of WAL. Old builds run
fine in WAL. To go back to `delete` mode anyway, stop the service and then run
`sqlite3 /opt/conductor/conductor.db "PRAGMA journal_mode=delete;"`.

After the release is verified, move the "Ongoing" items into
`claw/sop/deploy-to-prod.md` before clearing this note.
