# stable: restart_daemon crashes with `WebSocket not connected` before respawn (2026-04-24)

## Symptoms
- Users reported that `conductor daemon` restart was unstable and sometimes failed, leaving no running daemon.
- Typical log trail:
  ```
  [conductor-daemon ...] [restart_daemon] Received (request_id=restart-..., target=latest, current=0.2.39)
  [conductor-daemon ...] [restart_daemon] Already on latest (0.2.39); plain restart
  [conductor-daemon ...] [restart_daemon] Foreground daemon will be respawned in background. Logs: ~/.conductor/logs/conductor-daemon.log
  [conductor-daemon ...] Shutdown requested (restart_daemon); stopping 5 active task(s)
  [conductor-daemon ...] Uncaught exception: Error: WebSocket not connected
  ```
- After the uncaught exception, the daemon exits with code 1 **before** `restartDaemonProcess` reaches the `spawnFn(...)` / `exitFn(0)` step, so the new background daemon is never launched.

## Root Cause
Two cooperating issues in the shutdown path.

1. **SDK: send-after-disconnect still throws.** `ConductorWebSocketClient.sendJson` calls `ensureConnection` → `sendWithReconnect`, which unconditionally throws `WebSocket not connected` when `this.conn` is null. During `shutdownDaemon` the daemon first flushes `task_status_update` (KILLED) for every active task inside `Promise.allSettled` + `withTimeout`, then calls `client.disconnect()`. Any sendJson still queued (by watchdog, PTY exit handlers, outbox flush, etc.) after `disconnect()` flips `this.stop` and nulls `this.conn` rejects with `WebSocket not connected`. A subset of these call sites propagate the rejection without a `.catch`, turning it into an unhandled rejection.

2. **Daemon: unhandled rejection crashes shutdown.** The daemon only installed an `uncaughtException` handler (`cli/src/daemon.js`); there was no `unhandledRejection` handler. Since Node 15+, unhandled rejections are promoted to uncaught exceptions, so `onUncaughtException` fired mid-shutdown and called `cleanupLock(); exitFn(1);`. That kills the process **before** `restartDaemonProcess` can spawn the replacement daemon, so the user is left without a daemon.

Put together: a benign, expected race (`sendJson` losing to `disconnect()` during a controlled restart) became a fatal crash that aborted the respawn.

## Fix
`cli/src/daemon.js`
- Added a separate, early-declared `daemonShutdownInProgress` flag (set alongside `daemonShuttingDown` in `shutdownDaemon`, `handleSignal`, and the watchdog self-heal budget path) so process-level error handlers can read it safely even via TDZ.
- Added `isBenignShutdownError` that recognizes `WebSocket not connected` / `WebSocket is not open` / `WebSocket is closed`.
- When shutdown is in progress and the error is benign, `onUncaughtException` **logs and returns** instead of exiting. Normal shutdown flow is allowed to finish and spawn the replacement daemon.
- Added `process.on('unhandledRejection', onUnhandledRejection)` that shares the same logic, so late-rejecting sends never bypass the guard.

`modules/conductor-sdk/src/ws/client.ts`
- `sendJson` now short-circuits to a no-op when `this.stop` is true, both before and after `ensureConnection`.
- `ensureConnection` does not attempt to reopen a connection once `this.stop` is set.
- `sendWithReconnect` checks `this.stop` before each reconnect attempt and before throwing `WebSocket not connected`, so a disconnect that races with an in-flight send cleanly resolves instead of throwing.

Rebuilt `modules/conductor-sdk/dist` so the daemon picks up the guarded client. SDK tests (`cd modules/conductor-sdk && pnpm test` — 59 tests) still pass.

## Prevention
- Any Node daemon that owns its own process lifetime **must** register both `uncaughtException` and `unhandledRejection` handlers. Treat them as a pair.
- When writing shutdown code that tears down I/O (WebSocket, streams, DB connection), decide explicitly what to do with in-flight callers: either (a) make the teardown wait for them, or (b) make the resource a no-op once teardown starts so late callers see a silent success instead of a thrown error. We chose (b) for the WebSocket client because the daemon is restarting anyway.
- `Promise.race([userPromise, timeoutPromise])` does not cancel `userPromise`. It is fine because the internal race handler counts as a rejection handler, but **any other code path** that fires off `client.sendJson(...)` without `.catch` during shutdown is still a crash waiting to happen. Defensive `.stop` short-circuits in the client are cheaper than auditing every call site.
- Prefer wiring new shutdown paths through the `requestShutdown` / `daemonShutdownInProgress` signal instead of flipping `daemonShuttingDown` manually, so the process-level guards apply.

## Test Plan
- `cd modules/conductor-sdk && pnpm test` — all 59 tests pass.
- `cd cli && node --test test/daemon.test.js` — same 5 pre-existing failures as `main`; no new regressions.
- Manual: run `restart_daemon` while 5+ tasks are active and confirm the daemon respawns in the background (new PID logged via `[restart_daemon] New daemon spawned (PID ...)`).
