# stable: daemon is online but sentenced to offline review (2026-03-06)

## Symptoms
- The online `m1` daemon local process is still running, and the child fire process is also still alive.
- On the user side, the daemon is regarded as offline by the system, and exceptions occur in message delivery and task takeover.
- Looking further at the scene, daemon tmux pane did not exit the log, but the server has processed it according to the offline path.

## Root Cause
- The system maintains two sets of agent online status at the same time:
- `realtimeHub`: Based on websocket connection registration, logout and `pong` update activity.
- `heartbeatManager`: Maintain online status based on business layer `heartbeat` message.
- The daemon client usually only sends websocket `ping/pong` to keep alive, but does not stably send the business layer `type: "heartbeat"`.
- When the server receives websocket `pong`, it only refreshes `realtimeHub`, not `heartbeatManager`.
- But outbox and offline scanning rely on `heartbeatManager.isOnline()`, resulting in split-brain:
- The transport layer connection is still alive.
- The business layer online table has timed out.
- Eventually the living daemon was misjudged as offline.

## Fix
- Unify the agent's online source and only recognize `realtimeHub` when running.
- `outboxProcessor` uses `realtimeHub.hasAgentHost()` instead to determine whether the agent is online.
- Removed independent offline scanning in cron that relied on `heartbeatManager.checkOfflineAgents()`.
- When the websocket is actually `close`, the offline failure processing of the pending message is triggered to avoid accidental damage to the idle daemon.
- Add regression testing to cover:
- Only websocket presence, no business heartbeat is still considered online.
- The websocket enters the offline path only after it is actually disconnected.
- The host should not mistakenly mark the pending message as failed when reconnecting quickly.

## Prevention
- There can only be one runtime truth source in the online state, and transport heartbeat and business heartbeat cannot drive different decisions respectively.
- Any "automatic processing after offline" logic must be bound to the real link breaking event, rather than to another set of timeout cache.
- Create a separate regression test for the daemon idle scenario to verify that "no task traffic but the connection is still alive" will not be sentenced to offline.
- When adding or retaining an auxiliary state manager, you must first prove that it will not form a double-write fork with the existing presence mechanism.