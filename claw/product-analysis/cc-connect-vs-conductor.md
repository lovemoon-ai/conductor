# cc-connect vs Conductor

Research date: 2026-03-09Research object:`chenhg5/cc-connect`Research snapshot: `main` @ `3cbf69e1db643abc81b598da6b6880c1e5090718` (2026-03-09 18:08:15 +0800)
## Conclusion Summary
`cc-connect` is not a direct analog of `Conductor`.
More precisely:
- `cc-connect` is a chat-first local AI Agent bridge- `Conductor` is an agent control plane with web console, task model, daemon/fire execution end, reliable message link and commercial infrastructure
The two overlap, but at different levels:
- `cc-connect` is strong in the entrance layer, chat experience layer, and cross-platform access layer- `Conductor` is strong in control plane, task life cycle, reliable delivery, multi-user and multi-tenant capabilities
Therefore, `cc-connect` is more like the "upper-layer access reference" of `Conductor`, not a direct replacement for the core architecture.
## 1. What is cc-connect?
According to its README and configuration design, the core positioning of `cc-connect` is very clear:
- Remotely control the local AI Agent in chat platforms such as Feishu, Telegram, Slack, Discord, DingTalk, etc.- One process can manage multiple projects- Each project is bound to a working directory, an agent, and several messaging platforms- Session, command, cron, relay, memory, and permission modes are mainly completed through chat commands
Its core abstraction is:
- `Platform`: Feishu, Telegram, Slack and other messaging platform adapters- `Agent`: Claude Code, Codex, Gemini CLI, Cursor Agent and other agent adapters- `Engine`: Single-project message routing and session control center- `SessionManager`: Local JSON persistence session manager
From an implementation perspective, it is essentially a set of "local runtime + multi-platform message portal + multi-agent adaptation layer".
## 2. What is Conductor?
The current implementation of `Conductor` is significantly beyond the scope of a "local bridge".
As you can see from the existing code, it contains:
- Next.js web applications and APIs- WebSocket channel separated from app side and agent side- User, project, task, message, token, subscription, payment, verification code and other back-end models- daemon and `conductor-fire` two types of execution terminals- Task creation, allocation, recovery, stop, status return, offline recovery and other control plane logic- Reliable delivery mechanism at outbox / ack / DLQ level
This means that the true positioning of `Conductor` is closer to:
- Multi-user, multi-project, multi-task agent task orchestration system- control plane with web UI- Local daemon/fire as execution plane
## 3. Core differences
### 3.1 User entrance
`cc-connect` is chat-first:
- Users mainly complete interactions in the IM platform- `/mode`, `/memory`, `/cron`, relay, provider switching are all based on chat commands- Web UI is not the main entrance
`Conductor` is app-first:
- The core entrance is the web application, project list, task list, and task chat interface- The app subscribes to tasks and message updates via `/ws/app`- The agent side connects to the backend through `/ws/agent`
in conclusion:
- `cc-connect` gives priority to solving "people use agents remotely in chat tools"- `Conductor` gives priority to solving "how agent tasks are systematically managed, executed, recovered and billed"
### 3.2 Status truth
`cc-connect` mainly uses local files as state truth:
- `config.toml`
- JSON files such as session/history/relay under `~/.cc-connect`
`Conductor` mainly uses the backend database as the state truth:
- `User`
- `Project`
- `Task`
- `Message`
- `AgentOutbox`
- `DeadLetterQueue`
- `Verification`
- `Order`

in conclusion:
- `cc-connect` prefers stand-alone tool products- `Conductor` is a more centralized service product
### 3.3 Architecture Boundaries
The core boundary of `cc-connect` is roughly:
```text
IM platform
-> platform adapter
-> engine
-> local agent adapter
-> local agent process
```

The core boundary of `cc-connect` is roughly:
```text
web/app
-> backend API + realtime hub
-> task / message / outbox / subscription state
-> daemon / conductor-fire
-> ai-sdk / local runtime
-> local agent process
```

in conclusion:
- `cc-connect` uses the message entrance as the main axis- `Conductor` uses the task control plane as the spindle
### 3.4 Reliability model
`cc-connect` focuses on "continuous session availability" and "smooth platform access":
- Local session persistence- Multi-platform adaptation- relay
- cron
- Voice/picture support
`Conductor` focuses on "correct task life cycle" and "recoverable execution end":
- app/agent separated websocket- reconnect / resume
- stale task recovery
- agent outbox
- ack / final status waiter
- DLQ

in conclusion:
- `cc-connect` is a reliable interactive experience- `Conductor` partial control link is reliable
### 3.5 Commercialization and multi-tenancy
`cc-connect` is mainly used as a tool for individuals or small teams.
`Conductor` already has obvious SaaS infrastructure:
- User identity and token- subscription tier / status
- invite code
- payment order
- Free version restrictions and daemon / task current limit
in conclusion:
- `Conductor`'s target space is closer to platform products- `cc-connect`'s target space is closer to advanced local productivity tools
## 4. Overlap
There is still significant overlap between the two:
- They are all doing unified access to multiple agents.- All focus on persistent session- Pay attention to reconnect / resume- All abstract the differences in agent capabilities- Both support runtime permission mode switching
Therefore, from the perspective of "capability components", the two are adjacent; but from the perspective of "system main axis", they are different.
## 5. Points worth learning from cc-connect
### 5.1 Chat is control
This is the strongest source of product sense for `cc-connect`.
Representative ability:
- `/mode`
- `/memory`
- `/cron`
- provider switching- model switch- Command template- relay

Meaning of `Conductor`:
- Some agent management capabilities can be moved forward to the chat entrance- Reduce how often users have to open the web console- Improve usability in mobile/remote scenarios
### 5.2 Platform adaptation layer abstraction
The `Platform` / `Agent` interface design of `cc-connect` is very clean and suitable for reference.
Capability interfaces that are particularly worthy of reference:
- `ModeSwitcher`
- `MemoryFileProvider`
- `ModelSwitcher`
- `ProviderSwitcher`
- `SkillProvider`

Meaning of `Conductor`:
- Can be organized into a unified agent capability schema- Make the front-end, API, and execution end more standard for agent capability negotiation
### 5.3 Relay experience
`cc-connect`'s multi-robot relay is not a bottom-level scheduling innovation, but a strong interaction layer innovation.
Meaning of `Conductor`:
- "Multi-agent collaboration" can be made into an upper-level product feature- It is more user-friendly than simply stacking more backends on the backend
### 5.4 Voice / Picture / Multi-Platform Portal
This is the layer that `Conductor` is currently obviously weak on.
If user access needs to be expanded in the future:
- Feishu- Telegram
- Slack

It may be more effective than continuing to simply enhance the Web UI.
## 6. Points not recommended for copying
### 6.1 Do not move the stand-alone configuration model into the Conductor core
The configuration center of `cc-connect` is `config.toml`.
This is suitable for personal tools, not for `Conductor`'s current:
- User model- token model- plan limit
- Payment/subscription model
`Conductor` should not fall back to "local configuration files define system truth" mode.
### 6.2 Don't let the IM platform define the task model in turn
In `Conductor`, the task model is already a core domain object.
The correct direction should be:
- IM platform as ingress / egress adapter- Chat sessions mapped to `Project` / `Task`- But don't let the platform concept intrude into the core mission domain
### 6.3 Do not weaken existing reliable links
`Conductor`'s existing outbox / ack / stale recovery / reconnect logic is one of the system's moats.
When accessing the IM platform, you should not bypass:
- task state persistence- agent ownership
- final status return- outbox reinvestment
Otherwise, the system will be turned back into a tool bridge.
## 7. Suggested route for Conductor
The most reasonable direction is not to "transform Conductor into cc-connect", but:
1. Keep `Conductor` and continue to do system of record2. Add an IM gateway / channel adapter layer to the upper layer3. Let the IM message finalize `Project`, `Task`, `Message`4. Replies continue to be pushed back to the chat platform through the existing realtime / outbox link
The recommended staging is as follows.
### Phase 1: Single platform access
Prioritize access to a platform verification mode:
- Feishu, or- Telegram

The first edition only does:
- New session creation task- There is already a task to continue sending messages- Task status update pushback- assistant message pushback
### Phase 2: Command layer
Implemented in the platform-independent layer:
- `/mode`
- `/memory`
- `/attach`
- `/resume`
- `/new`

### Phase 3: Collaboration capabilities
repair:
- relay
- Multi-agent observation and switching- Group chat is bound to multiple agents
### Phase 4: Multimodality and Automation
repair:
- Speech to text- Image input- Scheduled tasks
## 8. Suggested Product Judgment
If you sum it up in one sentence:
- `cc-connect` solves "How do I use the local agent remotely in the chat tool"- `Conductor` solves "how agent tasks can be stably managed, distributed, restored, displayed and commercialized by a system"
so:
- `cc-connect` is not the core architecture rival of `Conductor`- It's more like `Conductor`'s strong reference sample on "Entry Layer/Chat Control Layer"
## 9. Direct inspiration for subsequent designs
If `Conductor` wants to absorb the advantages of `cc-connect`, it is recommended to absorb them first:
-IM entry level- Imperative agent control experience- relay collaborative experience- agent capability abstraction
Not recommended for absorption:
- Single-machine configuration-centered system model- Native JSON as main state truth- Reversely define the task system based on the chat platform structure
## refer to
### cc-connect

- <https://github.com/chenhg5/cc-connect>
- <https://github.com/chenhg5/cc-connect/blob/main/README.zh-CN.md>
- <https://github.com/chenhg5/cc-connect/blob/main/config.example.toml>
- <https://github.com/chenhg5/cc-connect/blob/main/core/interfaces.go>
- <https://github.com/chenhg5/cc-connect/blob/main/core/session.go>
- <https://github.com/chenhg5/cc-connect/blob/main/core/relay.go>

### Conductor

- [`web/server.ts`](../../web/server.ts)
- [`web/src/app/api/tasks/route.ts`](../../web/src/app/api/tasks/route.ts)
- [`web/src/lib/realtime/agent-gateway.ts`](../../web/src/lib/realtime/agent-gateway.ts)
- [`web/prisma/schema.prisma`](../../web/prisma/schema.prisma)
- [`cli/bin/conductor-fire.js`](../../cli/bin/conductor-fire.js)
- [`cli/src/daemon.js`](../../cli/src/daemon.js)
