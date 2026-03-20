# Problem review: Fire websocket is falsely active, causing online tasks to be automatically killed.

## Symptoms
- When a user uses `conductor fire` to process a task online, the task is marked as `killed` without being manually stopped.
- The fire host bound to the task is determined to be offline in the backend
- The user's subsequent messages cannot be delivered, and the outbox eventually appears `Agent offline` and enters DLQ
- Local investigation found that the `conductor fire` process itself did not exit, and the child process is still alive.

## Root Cause
- `conductor fire`'s websocket connection entered the false active state of "TCP is still ESTABLISHED, but the business layer no longer sends and receives heartbeats/messages"
- The backend agent gateway relies on websocket pong and message traffic to determine the agent's online status, so the host will be considered offline.
- The stale fire recovery in the task list interface will automatically update the task to `killed` after the fire host goes offline and times out.
- The daemon side already has stale websocket watchdog self-healing logic, but the `conductor fire` side lacks an equivalent mechanism, resulting in false active connections unable to self-heal.

## Fix
- Added `FireWatchdog` to `cli/bin/conductor-fire.js`
- watchdog records the latest `connectedAt`, `lastPongAt`, `lastInboundAt`
- When websocket has no health signal within the configured threshold for a long time, `forceReconnect("watchdog:stale_ws_health")` is actively triggered
- At the same time, the fire websocket disconnection diagnosis log is added to facilitate subsequent positioning.
- Expose `onPong` and `forceReconnect` in `modules/conductor-sdk/src/client.ts` for use by fire watchdog
- Added unit tests for fire watchdog, covering stale ws, self-healing cooling and health recovery scenarios after reconnection

## Prevention
- When fire and daemon share the same set of websocket health models, they must complete their self-healing capabilities simultaneously to avoid having only one side with watchdog
- Build a separate regression test for the "process survives but the connection is lost" scenario, and cannot only cover explicit close/error
- The online diagnostic interface should continuously output the latest pong / inbound time to reduce the cost of locating such false activity problems.
- Key stability changes to fire, priority is given to supplementing integration tests, and covering the real fault model of long-term no pong after reconnect