# Issue: PTY task transport phase 3 - WebRTC direct data channel

## Problem / Context

Even if P1 optimizes the existing relay, PTY still inherently has a structural problem:
- terminal echo comes from the remote PTY, not local optimistic echo
- Currently all input / output byte streams must pass through the central server
- Once one of the paths to browser <-> server or daemon <-> server is poor, the terminal feel will be significantly reduced.
Therefore, in the long term, it is necessary to let the "data plane" of PTY bypass the central node as much as possible; but the control plane (auth / writer lock / task lifecycle / fallback policy) should still remain on the server side.
In a browser environment, the most realistic solution is not raw TCP, but WebRTC DataChannel.

## Goal

On the premise that the control plane is still controlled by the server:
- Allow browsers and daemons to prioritize transmitting PTY byte streams through WebRTC DataChannel
- RTC quickly falls back to relay when connection establishment fails
- Does not destroy existing writer/viewer/task kill/ownership control semantics etc.

## Acceptance Criteria

- [ ] The server can serve as a signaling/auth/policy center to complete RTC ticket verification and SDP/ICE exchange
- [ ] browser and daemon can create PTY-specific DataChannel after authorization
- [ ] In direct mode, `terminal_input / terminal_resize / terminal_output` no longer passes through the server.
- [ ] When RTC negotiation fails, it will automatically fallback to relay within 2 seconds.
- [ ] In direct mode, when task kill, writer lock changes, or daemon ownership changes, the server can still forcefully converge the session state.
- [ ] During the grayscale period of direct mode, the task success rate and recoverability are not lower than the relay baseline.

## Scope

- In scope
- signaling protocols and message types
- RTC ticket / auth / TTL design
- daemon-side PTY direct transport worker
- browser terminal direct transport client
  - direct->relay fallback
- Basic observability: connection establishment success rate, fallback rate, session duration
- Out of scope
- All mission types are uniformly upgraded to RTC
- Complete audit system reconstruction
- Remove relay path

## Plan / Tasks

- [ ] Design signaling process: offer / answer / ICE / timeout / cancel
- [ ] Define server-side RTC ticket: bind user / task / daemon host / writer permissions / expiration time
- [ ] daemon adds direct data channel worker and binds it to the existing PTY session
- [ ] browser adds direct transport client, management negotiation / open / fallback
- [ ] implement input / resize / output / exit / error event mapping in direct mode
- [ ] Preserve the server control plane: writer lock changes, task kill, detach can force the direct channel to be downgraded or closed
- [ ] Introduce grayscale switch, only enable it for some users / hosts / tasks
- [ ] Add direct success rate / fallback rate / TURN usage / latency comparison indicators

## Risks / Dependencies

- NAT/Firewall/Enterprise network can significantly affect RTC success rate
- If TURN is required, relay costs and deployment complexity will increase
- If sufficient seq/checkpoint/event reporting is not retained in direct mode, troubleshooting and playback capabilities will be weakened.
- The direct strategy of a browser with multiple viewers and a single writer needs to be defined in advance, otherwise the permission model may bifurcate
- Rely on P2 to complete the transport session and adapter abstraction first

## Runtime / Rollout Notes

- The server needs to explicitly open `PTY_TRANSPORT_POLICY=direct_preferred`
- The daemon side gives priority to installing the optional dependency `@roamhq/wrtc`
- daemon can control the RTC module detection sequence through `CONDUCTOR_PTY_RTC_MODULES=@roamhq/wrtc,wrtc`
- If you need to stop bleeding online quickly, you can set `CONDUCTOR_DISABLE_PTY_DIRECT_RTC=1` to force it back to relay-only

## Links

- RFC: `claw/rfc/0012-feature-pty-task-transport-optimization.md`
- Depends on issue:
- `claw/issues/pty-task-transport-phase1-relay-latency-observability
- 20260317.md`
  - `claw/issues/pty-task-transport-phase2-control-data-plane-split-20260317.md`
Related code:
- 
- `web/src/lib/realtime/app-gateway.ts`
  - `web/src/lib/realtime/agent-gateway.ts`
  - `web/src/lib/realtime/hub.ts`
  - `web/src/lib/conductor/stores/websocket.ts`
  - `web/src/components/conductor/terminal/TerminalView.tsx`
  - `cli/src/daemon.js`
