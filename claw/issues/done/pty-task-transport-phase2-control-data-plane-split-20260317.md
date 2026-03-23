# Issue: PTY task transport phase 2 - control/data plane split

## Problem / Context

Current PTY-related events are mixed in a common realtime event stream:
- `terminal_attach`
- `terminal_set_mode`
- `terminal_input`
- `terminal_resize`
- `terminal_detach`
- `terminal_output`
- `terminal_exit`
- `terminal_error`
This brings up two problems:
1. If you want to use low-latency dedicated transmission of browser <-> daemon in the future, the protocol boundary is not clear.2. The control plane (attach / auth / writer lock / viewer count) and the data plane (input / output byte stream) are not clearly layered
If you directly force RTC/P2P logic into the existing event flow, it will make the app gateway, agent gateway, daemon handler, and browser terminal store all more difficult to maintain.

## Goal

Under the premise that relay is still used by default:
-Clearly distinguish between PTY control plane and data plane- Introduce independent session / state abstraction for PTY transport- Reserve an interface for P3's direct data channel without immediately introducing WebRTC complexity

## Acceptance Criteria

- [ ] After `terminal_attach` is successful, the server can issue `pty_transport_session` (or equivalent object)
- [ ] browser terminal store can distinguish between `control-plane state` and `data-plane state`
- [ ] The daemon-side PTY stream processing logic has the transport adapter abstraction
- [ ] relay is still the default transport, and there is no return to the existing network function.
- [ ] The server has transport policy switch based on task / host / user

## Scope

- In scope
- Added `pty_transport_session` protocol object
- Add transport state to browser terminal state
- daemon abstract PTY stream adapter / transport adapter
- Server maintains PTY transport policy/session life cycle
- Clarify the message boundaries between control plane and data plane
- Out of scope
- Real browser-daemon RTC link building
- TURN / ICE / signaling implementation
- direct mode is enabled by default

## Plan / Tasks

- [ ] Design `pty_transport_session` structure: task_id / session_id / mode / ticket / expires_at / policy
- [ ] Define the boundary between control plane messages and data plane messages
- [ ] Browser terminal store introduces transport state:`relay | negotiating | direct | fallback_relay`
- [ ] daemon abstracts the sending and receiving logic of the current PTY session into an adapter interface
- [ ] The server sends the transport session information after the attach is successful.
- [ ] Reserve capability / feature flag for subsequent direct mode
- [ ] Supplementary testing to ensure that the relay path behavior is consistent with the current one

## Risks / Dependencies

- If the protocol design is too heavy, it will introduce complexity without immediate benefits.
- Browser store, server realtimeHub, daemon state machine need to be unified and abstracted, which is prone to boundary inconsistencies.
- It is necessary to confirm the focus of subsequent optimization based on the observation results of P1

## Links

- RFC: `claw/rfc/0012-feature-pty-task-transport-optimization.md`
Related code:
- 
- `web/src/lib/realtime/app-gateway.ts`
  - `web/src/lib/realtime/agent-gateway.ts`
  - `web/src/lib/realtime/hub.ts`
  - `web/src/lib/conductor/stores/websocket.ts`
  - `cli/src/daemon.js`
