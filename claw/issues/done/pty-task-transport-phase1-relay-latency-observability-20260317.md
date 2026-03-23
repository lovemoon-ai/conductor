# Issue: PTY task transport phase 1 - relay latency & observability

## Problem / Context

The current PTY task link is:
- browser connects `web/src/lib/conductor/stores/websocket.ts` to `/ws/app`
- `web/src/components/conductor/terminal/TerminalView.tsx` Send `terminal_input`
- `web/src/lib/realtime/app-gateway.ts` forwarded to `realtimeHub`
- The server then sends it to the daemon through `/ws/agent`
- daemon drives PTY at `cli/src/daemon.js` and returns `terminal_output`
- `web/src/lib/realtime/agent-gateway.ts` broadcasts back to browser
This link is fully functional, but the PTY input echo delay is easily amplified by the following factors:
- Both browser and daemon bidirectional websockets pass through the central relay
- Web page traffic and realtime websocket reuse the same entrance, which may be affected by the proxy layer/CDN path
- Lack of fine-grained end-to-end latency observation, currently it can only perceive "slowness" and cannot accurately determine the main time-consuming period
Before making any P2P/RTC solution, low-cost optimization and quantification of the existing relay path should be completed first.

## Goal

Without changing the overall topology:
- Reduce PTY latency in existing relay mode
- Establish PTY end-to-end delay observation
- Verify if proxy layer/central transit is the main bottleneck

## Acceptance Criteria

- [ ] Browser and daemon support configuring independent realtime websocket domain name/entrance
- [ ] `pty_task` can record at least one set of end-to-end latency indicators: `input_sent -> daemon_received -> first_output -> browser_rendered`
- [ ] The server can distinguish app gateway time-consuming, agent gateway time-consuming, and daemon execution time-consuming
- [ ] Can get at least one round of grayscale data to make a baseline comparison of PTY P50/P95 latency
- [ ] relay path function has no regression: attach / input / resize / detach / output / exit are all normal

## Scope

- In scope
- Added independent realtime host/config capability for `/ws/app` and `/ws/agent`
- Add PTY latency buried points on browser / server / daemon terminals
- Added PTY transport related logs and diagnostic output
- Check and optimize websocket keepalive / flush / high-frequency packet behavior
- Out of scope
  - WebRTC / DataChannel
- New PTY transport session protocol
- Direct link building between browser and daemon

## Plan / Tasks

- [ ] Sort out the key time points and buryable points on the current PTY link
- [ ] Add timestamp collection on the browser side for `terminal_input` and the first corresponding `terminal_output`
- [ ] The daemon side records the time point when receiving `terminal_input`, writing to PTY, and the first packet output
- [ ] Server record `/ws/app -> hub -> /ws/agent` transfer time
- [ ] Add configurable realtime websocket host for browser and daemon
- [ ] Add diagnostic output to facilitate viewing transport latency segments by task
- [ ] Grayscale verification unproxied / PTY improvement of independent ws host

## Risks / Dependencies

- The clocks of the browser and daemon are not exactly the same, so you need to pay attention to the deviation when calculating cross-end absolute time.
- If proxy layer configuration adjustment is required, it may depend on infrastructure changes
- If the design of P1 indicator is unreasonable, subsequent P2/P3 may be based on wrong judgment.

## Links

- RFC: `claw/rfc/0012-feature-pty-task-transport-optimization.md`
-Related codes:
- `web/src/lib/conductor/stores/websocket.ts`
  - `web/src/components/conductor/terminal/TerminalView.tsx`
  - `web/src/lib/realtime/app-gateway.ts`
  - `web/src/lib/realtime/agent-gateway.ts`
  - `cli/src/daemon.js`
