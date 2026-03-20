# PTY Task transmission optimization solution: Relay to reduce latency + data plane direct connection reservation
## state
- Document status:Draft- Update time: 2026-03-17
## Summary

The current interactive link of the PTY task is `browser -> /ws/app -> server realtimeHub -> /ws/agent -> daemon -> PTY`, and the echo is returned to the browser through the same path in reverse. The architecture is simple to implement, and authentication and permissions are centralized. However, in weak networks, proxy layers, cross-regional links, and Cloudflare transfer scenarios, users will obviously perceive the terminal input echo delay. This article proposes a three-stage optimization plan: P1 optimizes the existing relay path and observation; P2 converts PTY The control plane and data plane are split into a low-latency path convergence protocol; P3 introduces the WebRTC DataChannel direct connection capability of the browser <-> daemon while retaining the server control plane, and uses relay as a stable fallback.
## Context

The current PTY link involves the following modules:
- Browser connection: `web/src/lib/conductor/stores/websocket.ts` connection `/ws/app`- Input send: `web/src/components/conductor/terminal/TerminalView.tsx` send `terminal_input`- Server app gateway:`web/src/lib/realtime/app-gateway.ts`- Server agent gateway:`web/src/lib/realtime/agent-gateway.ts`- daemon PTY execution: `cli/src/daemon.js`- Server forwarding center: `web/src/lib/realtime/hub.ts`
The problem with the current link is not "functionality is unavailable", but "interaction surface delay is amplified by the central transit path":
- terminal echo relies on remote PTY return, not local optimistic rendering- Both browser and daemon WS may go through proxy/CDN/edge network- The terminal byte stream passes through the server in both directions, and the node burden and jitter are amplified.- The current central path is also responsible for authentication, authority arbitration, real-time forwarding, and connection recovery, resulting in limited optimization space.
Known reality constraints:
- The browser cannot directly connect to the daemon's raw TCP.- task life cycle, writer/viewer permissions, and audit information should still be controlled by the server- In enterprise NAT / firewall / symmetric NAT scenario, P2P cannot be 100% successful, and relay fallback is required
## Goals

- Reduce the end-to-end delay from PTY input to echo- Reduce the bandwidth and connection pressure of the central server on the PTY byte stream- Retain the existing task/auth/permission model and do not break the security boundary due to transmission optimization- Reserve protocol space for the quasi-direct/direct connection capabilities of subsequent browsers and daemons- Provide a clear, grayscale, and rollback implementation path for each stage
## Non-Goals

- Do not reconstruct the message transmission architecture of ordinary AI tasks in this RFC- Do not do "completely server-side" pure decentralized connection in this RFC- Achieve 100% direct connection between browser and daemon without requiring the first version- Does not require bypassing all intermediate nodes; if NAT penetration fails, fallback to relay/TURN is allowed
## Options Considered

### Option A: Maintain the status quo and only make minor repairs
advantage:
- Minimal changes- No new protocols and compatibility burdens
shortcoming:
- It can only fix the stability problem, but it is difficult to cure PTY latency- The server continues to carry all PTY byte streams- Unable to reserve protocol boundaries for subsequent direct connection capabilities
### Option B: Directly change the browser and daemon to the public network WSS direct connection
advantage:
-Theoretical link is the shortest- The protocol implementation is simpler than WebRTC
shortcoming:
- The daemon exposes the public network entrance, certificate, NAT, dynamic IP, and home network, which is very troublesome.- The security surface has been expanded and is not suitable as the default solution.- The vast majority of end-user environments cannot be relied upon
### Option C: The control plane retains the server side, the PTY data plane is optimized in stages, and ultimately supports WebRTC DataChannel
advantage:
- Compatible with browser capability model- The server still retains authentication, life cycle, and authority arbitration- Can be grayscale, fallback, and delivered in stages- First reap the benefits of relay optimization, and then gradually evolve to quasi-direct/direct connection
shortcoming:
- The protocol and state machine are more complex- Need to handle signaling, ICE, TURN, fallback- Need to supplement observability and diagnostic capabilities
## Proposed Design

Option C is adopted and divided into three stages: P1 / P2 / P3.
### P1: Optimize the existing relay path without changing the overall topology
Goal: First use the minimum cost to reduce the PTY latency of the existing network and establish quantifiable observations.
design:
1. Split the PTY websocket path from ordinary web page traffic- The browser side supports using independent realtime domain name to connect `/ws/app`- The daemon side supports using an independent realtime domain name to connect to `/ws/agent`- Try to avoid unnecessary CDN proxy / edge relay2. Add PTY transport observation field- browser records `terminal_input` local sending time- daemon returns echo packet to `terminal_output` seq / server timestamp / optional echo timestamp- server records the transfer time between app gateway and agent gateway3. Add end-to-end delay indicators   - input->daemon received
   - daemon write->first output
   - output->browser rendered
4. Optimize relay parameters- Reduce unnecessary message encapsulation overhead- Check websocket ping/pong, flush, batch sending strategy- Make separate configurations for PTY high-frequency small packet scenarios
P1 does not change the permission model:
- `terminal_attach`
- `terminal_set_mode`
- `terminal_input`
- `terminal_resize`
- `terminal_detach`

Still relayed via server.
### P2: Control plane / data plane split, but still uses relay by default
Goal: Without introducing real P2P, first separate PTY-related protocols from "general realtime events" to form an independent transport layer.
design:
1. Introduce the concept of PTY transport session- The server issues `pty_transport_session` after `terminal_attach` is successful.- Includes: `task_id`, `session_id`, `transport_mode`, `writer_connection_id`, short-term ticket, expiration time2. Distinguish between control plane and data plane- The control surface continues to use the existing server:attach / detach / writer lock / viewer count / stop / auth- The data plane is unified and abstracted as `pty_data_channel`3. Abstract daemon side PTY stream adapter- relay adapter: reuse existing `/ws/agent`- direct-capable adapter: Reserved interface for P3's RTC data channel4. Add transport state to browser terminal store   - `relay`
   - `negotiating`
   - `direct`
   - `fallback_relay`
5. The server maintains transport policy for each PTY session- Default `relay`- Allow access to `direct_preferred` for grayscale users or environments
The core of P2 is not to "immediately speed up", but to extract the protocol boundaries required for subsequent direct connections to avoid shoehorning WebRTC details into the existing `/ws/app` ordinary event stream.
### P3: Introducing WebRTC DataChannel as a direct connection to the PTY data plane
Goal: Under the premise that the control plane is still controlled by the server, the browser and daemon will give priority to the direct data channel to transmit the PTY byte stream.
design:
1. The server is only responsible for signaling / auth / policy- Request direct channel after browser attach- The server verifies task ownership, writer permissions, and daemon online status- The server issues a one-time RTC ticket- browser and daemon exchange SDP / ICE through server2. daemon adds RTC transport worker- Bind to existing PTY session- Receive browser data channel `input/resize`- Push `output/exit/error` directly back to browser3. The server retains strong control capabilities- writer lock is still arbitrated by server- When the writer is preempted, the task is killed, or the daemon ownership changes, the server can require the direct channel to be downgraded or disconnected4. The fallback mechanism must be built-in- RTC connection establishment timeout (such as 1~2 seconds) automatically falls back to relay- DataChannel automatically switches back to relay when disconnected- When TURN is unavailable or the network is limited, task availability will not be affected5. Auditing and playback should be kept to a minimum closed loop- daemon still reports `terminal_opened` / `terminal_exit` / `terminal_error` to the server- Optionally only report seq/checkpoint for output in direct mode, and do not require complete mirroring of each byte stream- If the product requires complete auditing, you can configure the direct mode dual-write server (at the cost of partially offsetting the benefits)
## Architecture Notes

### Current link
`browser -> /ws/app -> app-gateway -> realtimeHub -> /ws/agent -> daemon -> PTY -> /ws/agent -> agent-gateway -> realtimeHub -> /ws/app -> browser`

### P3 target link
Control surface:
`browser -> /ws/app -> server`

Data side priority:
`browser <-> WebRTC DataChannel <-> daemon`

Fallback on failure:
`browser -> /ws/app -> server -> /ws/agent -> daemon`

### Why not do pure browser->daemon raw socket
- The browser security model does not allow arbitrary raw TCP- Public network daemon exposure is not feasible for most user environments- WebRTC is the most realistic low-latency direct connection method in browsers
## Risks

- NAT/firewall/enterprise network may cause RTC success rate to be unstable- When TURN is used as a fallback, traffic will still pass through the relay, and the revenue will be lower than that of direct connection- If the audit is not done enough in direct mode, it will weaken the troubleshooting ability.- If writer/viewer permissions are maintained bilaterally on the server and direct channel at the same time, it is easy to cause state bifurcation.- terminal reconnect / tab refresh / daemon resume will significantly complicate the state machine
## Rollout

### P1

- Added independent realtime domain name and configuration switch- Added PTY latency indicators and logs- Low flow grayscale observation PTY P50/P95
### P2

- Added `pty_transport_session` protocol object- Browser and daemon abstract transport adapter- Relay is still used by default and RTC is not enabled.
### P3

-Introduction of signaling API/message types- daemon adds RTC transport worker- Browser terminal priority direct, automatic fallback relay on failure- Enable grayscale for specified users/specified hosts/specified task types
### P3 runtime implementation instructions
- Server grayscale switch: `PTY_TRANSPORT_POLICY=direct_preferred`- The daemon needs to have the Node WebRTC runtime, and the optional dependency `@roamhq/wrtc` is preferred.- daemon can specify the RTC module detection sequence through `CONDUCTOR_PTY_RTC_MODULES=@roamhq/wrtc,wrtc`- If you need to urgently shut down the daemon's direct connection capability, you can set `CONDUCTOR_DISABLE_PTY_DIRECT_RTC=1` to automatically only relay fallback.
## Acceptance

### P1 Acceptance

- [ ] Browser and daemon support configuring independent realtime WS domain name- [ ] can observe the end-to-end delay of PTY input->first output- [ ] P95 latency in PTY relay mode is lower than the current baseline, or at least the main time-consuming period can be clearly identified
### P2 Acceptance

- [ ] After `terminal_attach`, the server can issue `pty_transport_session`- [ ] Browser terminal store can distinguish control-plane and data-plane status- [ ] daemon PTY stream processing logic can switch transport adapter, and the relay path has no functional regression
### P3 Acceptance

- [ ] browser and daemon can establish RTC data channel after server authorization- [ ] In direct mode, `terminal_input / terminal_resize / terminal_output` no longer passes through the server.- [ ] Automatically fall back to relay within 2 seconds when RTC negotiation fails.- [ ] When writer lock, task kill, daemon ownership changes, the server can still forcefully converge the PTY session state- [ ] During the grayscale period of direct mode, the task success rate and recoverability are not lower than the relay baseline.
## Open Questions

- Do I need to keep the full terminal output audit for direct mode, or just the checkpoint/seq?- Is the TURN service self-built, or does it rely on a hosting solution?- Is direct mode only enabled for `pty_task`, or will it be extended to other low-latency streaming channels in the future?- Is P1 enough to solve 80% of online PTY latency? If so, is P3 still worth investing in first?- When the browser has multiple viewers watching the same PTY session, is it allowed to have one writer + multiple direct viewers, or do viewers continue to use relay?
## Recommendation

Recommended priority:
1. Do P1 first to verify whether the real bottleneck mainly comes from the agent layer/center relay path2. Do P2 again and abstract the PTY transport from the general realtime event.3. Finally, Grayscale P3 only uses "direct data plane connection" as an enhancement capability of PTY, instead of defaulting to strong dependence.
This is the order of advancement with the most reasonable benefit/risk ratio.