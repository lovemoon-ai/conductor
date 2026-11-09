# Wedged fire (stalled WS handshake) blocks restart forever

Task: `beffaf21-e6c3-4d10-a868-5455da1b4fd0` ("【竞赛】challenge-2026"; claude-opus, tmux mode on ruofo, CLI 0.17.1).

## Symptom
Every restart failed with `restart failed: task already active in tmux session conductor-fire-beffaf21-…-mvrd0656tlwz — stop the task before restarting`, and the failure set the task to `killed`. Stop did not help either: PATCH `status: killed` on a task that is already `killed` sends no `stop_task`. The only way out was to `tmux kill-session` on the host by hand.

## Root cause
1. **Handshake never times out.** On 2026-10-30 ~19:00 (Shanghai) the fire got `pong_timeout` about once a minute. Its last reconnect stalled mid-TLS: `ss` showed 768 B sent, 1448 B received, retransmits, and no traffic for 6+ days. `defaultConnectImpl` in `modules/conductor-sdk/src/ws/client.ts` created the `ws` socket without `handshakeTimeout`, so the connect promise never settled. The fire logged nothing more, stayed alive in tmux at 0% CPU, and was not connected to the backend.
2. **The watchdog could not heal it.** `openConnection` waits on that promise while holding the reconnect lock. `FireWatchdog` → `forceReconnect` sees `conn=null`, calls `openConnection`, and queues behind the same lock.
3. **The restart gate trusts tmux only.** `handleRestartTask` treats "tmux session exists" as "fire is live" and refuses. Daemon restarts made it worse: each one adopted the session again as a live fire.

## Fix
- SDK: `handshakeTimeout` (30s) on the WebSocket connect. A stalled handshake now rejects, and the reconnect loop retries.
- Restart route: for an in-place `restart_task`, if no fire host of the task (`listDaemonTaskFireHosts`) is connected, add `replace_existing_fire: true`.
- Daemon: `restart_task` with `replace_existing_fire` stops the stale fire through `releaseReplacedFire` (the same path persistent rounds use) before the "already active" gate, then spawns normally.
- Ops: killed the zombie session on ruofo and restarted in place. The fire reconnected.

## Avoid next time
- Every network await needs a deadline. A promise that can hang inside a lock turns one lost packet into a dead process that never exits and never reports anything.
- "Is the task alive?" has three answers: server status, daemon process/tmux record, and fire ws connection. A recovery action the user triggers must not be blocked by one layer's local view when another layer (here, the server's connection registry) already knows that view is wrong. When you add a gate, ask which layer can contradict it and pass that signal along.
- When a gate's error says "do X first", check that X is actually possible from the state the error leaves behind.
