# Channel Gateway Core access solution (Feishu Adapter Phase 1)
## Status

Proposed

## Owner

TBD

## Date

2026-03-14

## Summary

This solution positions IM access as a universal message entry layer of `Conductor`, rather than a specialized integration of a separate platform.The core idea is: keep `Conductor` as the system of record of task / message / agent ownership / outbox,Add a general `Channel Gateway Core` in the backend to standardize messages from Feishu, Slack, DingTalk and other channels first.Then complete the existing `Task` / `Message`, and push back the assistant message and task status from the agent side to each provider through independent channel outboxes.For IM, it is just a shell for sending and receiving tasks/messages. It does not own the task itself, nor does it own the truth of the original AI session on daemon/fire.
The first provider of Phase 1 is Feishu, so the provider-specific details in the document use `Feishu Adapter` as an example. Phase 1 directly uses webhook transport instead of long connections. The reason is that webhook is more in line with `Conductor`'s current centralized back-end architecture and is more robust in terms of connection stability, multi-copy deployment, fault recovery and operation and maintenance observability. The whole still maintains the "universal channel core + provider adapter + channel inbox/outbox" form, rather than stuffing Feishu logic into the daemon, or scattering provider callback processing directly into the existing task API route.
## Context

- The current core domain of `Conductor` is relatively clear:
- `web/src/app/api/tasks/route.ts` is responsible for task ingress.
- `web/src/app/api/tasks/[taskId]/messages/route.ts` is responsible for user message ingress.
- `web/src/app/api/agent/events/route.ts` and `web/src/lib/realtime/agent-upstream.ts` are responsible for agent uplink submission.
- `AgentOutbox` / `DeadLetterQueue` in `web/src/lib/realtime/agent-outbox.ts` and `web/prisma/schema.prisma` provide reliable downlink.
- The current user model only has a single `User.provider/providerId`, which is more suitable for "one main login provider" and is not suitable for directly binding any IM account to the `users` table.
- Existing research conclusions clearly point out: When accessing the IM platform, the platform concept should not be allowed to reversely define the task model, nor should the existing outbox / ack / stale recovery / reconnect links be bypassed.
- Enterprise IM channels typically share the following concepts at an abstract level:- external user identity
- Single chat / group chat / thread or reply context  - bot mention / command
- Idempotent keys for inbound events
- Outbound messaging API, throttling and error retries
- But there are also obvious provider differences between different IMs:
- Different transport forms: webhook, long connection, socket mode, etc.
- Session and thread semantics are different
- Cards, buttons, attachments, and slash commands have different semantics
- OAuth, tenant, authentication, and signature verification methods are different
- Therefore, it is necessary to explicitly separate the "universal channel core" and "provider adapter" instead of writing a Feishu-specific implementation and then copying the Slack/DingTalk version.
- Feishu officially supports two event/callback access methods at the same time:
- Long connection: Establish a WebSocket long connection through Feishu SDK to receive events. Official recommendations are given for "self-built enterprise applications that have integrated SDK".
- Webhook: The open platform pushes HTTP POST to the developer's public address.
- Official capabilities directly related to this solution on the Feishu messaging side include:
- Receive message event:`im.message.receive_v1`
- Reply message API:`POST /open-apis/im/v1/messages/:message_id/reply`
- Authorized login OAuth 2.0:`authorize` + `oauth/token`
## Goals

- Support users to create tasks, continue tasks, and stop tasks in Feishu single chat or group chat `@bot`.
- Make Feishu the first provider adapter, and ensure that the same channel core is reused when subsequent Slack/DingTalk access.
- Keep `Conductor` still the single source of truth for tasks, messages, status, and bindings.
- Reuse existing daemon/fire, `AgentOutbox`, `/api/agent/events`, `realtimeHub` links.
- Allow the same task to be observed and continued to be operated by Web App and Feishu at the same time.
- Reserve a common channel adapter structure for subsequent Slack/DingTalk/Telegram/Feishu card interactions.
## Non-Goals

- Do not implement a single-machine architecture of "local Feishu bridge directly calls the local Codex".
- Do not pursue a "universal IM protocol layer" with zero provider differences.
- Do not do tmux/session bridge, terminal screenshot return, and real-time token streaming in Phase 1.
- Voice, image upload, card interaction, and approval flow are not fully supported in Phase 1.
- Prevent Feishu from becoming a new system of record.
- The CLI/daemon side is not required to open new ports or change protocols specifically for Feishu.
## Options Considered

### Option A: Let the daemon pick up Feishu directly
- advantage
- Closest to the bridge product in the survey.
- The local end can directly connect to long-term sessions.- shortcoming
- Bypass `Conductor`'s task / message / ownership / outbox truth source.
- Rebuild the system back to "stand-alone chat bridge".
- Multi-user, multi-device, web viewing, and commercialization restrictions will be weakened.
Conclusion: Rejected. This direction goes against the current product and architecture axis of `Conductor`.
### Option B: The backend is integrated with Feishu version, Slack version, and DingTalk version.
- advantage
- Each provider can be quickly implemented according to platform characteristics.
- It seems more straightforward in the early stage, and there is no need to abstract it first.- shortcoming
- Binding, session, idempotence, pushback, and current limiting logic will be copied multiple times.
- Subsequent Slack/DingTalk could easily evolve into three sets of implementations that are similar but behave inconsistently.
- `Conductor` loses a unified channel domain.
Conclusion: Rejected. It is better than direct daemon connection, but will still spread provider differences to the periphery of the core domain.
### Option C: `Channel Gateway Core + Provider Adapter`

- advantage
- Most consistent with the current `Conductor` architecture: IM is just the entry layer, and tasks/messages are still written back to the central domain.
- `ExternalAccount` / `ChannelConversation` / `ChannelInbox` / `ChannelOutbox` can be reused by multiple IMs.
- When connecting to Slack/DingTalk, most of the work falls on the adapter instead of repeatedly changing the task core.
- Can isolate provider-specific transport, thread, card, and authentication differences in the adapter.- shortcoming
- The channel normalized contract needs to be defined in advance, which puts more pressure on abstract design.
- If you abstract too much, you can easily fall into the lowest-common-denominator trap.
Conclusion: Choose this solution as the main architecture.
### Option D: Feishu Adapter uses webhook as transport
- advantage
- More suitable for centralized services, no single point long connection worker.
- Multi-copy deployment is naturally more friendly.
- The production pattern is more stable.- shortcoming
- Requires public network callback address, URL verification, Encrypt Key decryption, and Verification Token verification.
- Local development and early joint debugging costs are higher.
Conclusion: Select this solution as Feishu Phase 1 and long-term production transport solution.
### Option E: Feishu Adapter uses long connection worker as transport
- advantage
- Feishu officially recommends this method for "self-built enterprise applications that have integrated SDK".
- Does not require separate public network callback exposure.
- SDK has handled most of the authentication and decryption logic, and MVP has the lowest cost.- shortcoming
- A singleton worker is required; if multiple copies are deployed, single instance constraints or leader election must be done.
- Not suitable for embedding directly in every web copy.
Conclusion: Rejection. Long connections introduce singleton, reconnection, connection keep-alive and multi-copy coordination issues in this project. They are not as stable as webhook and will not enter the formal solution.
## Proposed Design

### 1. Form selection
Phase 1 uses:
- A general `Channel Gateway Core`, placed inside the `Conductor` backend, is responsible for the shared channel domain and task bridge.
- A `Feishu Adapter`, as the first provider adapter is responsible for webhook inbound, signature verification/authentication, provider payload normalize, provider send API.
- A set of general channel domain tables: `ExternalAccount`, `ChannelConversation`, `ChannelInbox`, `ChannelOutbox`.
- A layer of shared task ingress service, which extracts the task/message creation logic in the current API route.
Core constraints:
- IM provider is only responsible for ingress / egress.
- All actual task/message/status are still written to the existing DB.
- All agents still reuse `AgentOutbox` for downlink.
- All channels push back the new `ChannelOutbox` and do not mix with agent outbox.
- `ChannelConversation` cannot be modeled as "only equal to one DM"; the same provider must be allowed to carry both `chat` and `chat + topic/thread` targets.
- `TaskEventProjector` can only rely on the abstraction of "projecting to a certain conversation target" and cannot hard-code the outbound target into a single chat.
- Even if only Feishu DanChat is delivered in Phase 1, the reuse space should be reserved for subsequent expansion into "one topic group carries multiple topics, and each topic corresponds to a task".
### 2. The boundary between Core and Adapter
`Channel Gateway Core` is responsible for:
- `ExternalAccount` binding relationship
- `ChannelConversation` routing and task mapping
- `ChannelInbox` / `ChannelOutbox`
- `TaskIngressService`
- `TaskEventProjector`
- General command processing: `/bind`, `/new`, `/task`, `/stop`
- Idempotent, retry, aggregation, current limiting, auditing
`Channel Gateway Core` is responsible for:
- Provider inbound signature verification, authentication, decryption- provider payload -> normalized event
- normalized outbound -> provider send API
- Provider capabilities detection and downgrade- provider-specific error code mapping
It is recommended to define the minimum standard interface:
```ts
interface ChannelProviderAdapter {
  provider: "FEISHU" | "SLACK" | "DINGTALK";

  verifyInbound(request: unknown): Promise<void>;
  normalizeInbound(request: unknown): Promise<NormalizedInboundEvent[]>;
  sendOutbound(message: NormalizedOutboundMessage): Promise<ProviderSendResult>;
  getCapabilities(): ProviderCapabilities;
}
```

Recommended minimum normalized contract:
```ts
type NormalizedInboundEvent = {
  provider: string;
  externalUserId: string;
  externalTenantId?: string | null;
  externalChatId: string;
  externalThreadId?: string | null;
  externalTopicId?: string | null;
  externalRootMessageId?: string | null;
  externalMessageId: string;
  conversationType: "dm" | "group";
  text?: string | null;
  mentionsBot: boolean;
  command?: string | null;
  rawPayload: unknown;
};
```

```ts
type NormalizedOutboundMessage = {
  provider: string;
  conversationId: string;
  targetChatId: string;
  targetReplyMessageId?: string | null;
  targetThreadId?: string | null;
  targetTopicId?: string | null;
  kind: "assistant_message" | "task_status" | "system_notice";
  text: string;
  dedupeKey: string;
  metadata?: Record<string, unknown>;
};
```

This contract only expresses the minimum common denominator that the channel core really needs, and does not force all provider cards, approvals, documents, and actions to be extracted into unified fields.
### 3. Overall link
```text
Feishu Adapter / Slack Adapter / DingTalk Adapter
-> ChannelInbox (persistent + idempotent)-> Channel Router
-> TaskIngressService
-> Task / Message / AgentOutbox / RealtimeHub
-> daemon / fire / agent
-> /api/agent/events
-> AgentUpstream commit
-> ChannelProjector
-> ChannelOutbox
-> Provider Adapter Send API
```

The most critical design point here is not "how to collect Feishu messages", but "after any IM message enters the system, it must fall into the existing task/message semantics".
### 4. Extract shared services first
Currently, `web/src/app/api/tasks/route.ts` and `web/src/app/api/tasks/[taskId]/messages/route.ts` directly contain a large amount of business logic. If any provider adapter directly copies these logic, a dual implementation fork will immediately occur.
Therefore, before connecting to the channel provider, first select two types of shared services:
- `TaskIngressService`
  
- `createTaskForUser(...)`
  
- `appendUserMessageToTask(...)`
- Internally continue to reuse the current plan limit, default agent selection, `enqueueAndAttemptAgentCommand(...)`
- `TaskEventProjector`
- Extract the logic of "write the library and then fan out" from `commitSdkMessage(...)` / `commitTaskStatusUpdate(...)`.
- The currently existing projector is `realtimeHub.broadcast(...)`.
- Added a new projector responsible for converting visible task updates into `ChannelOutbox` lines.
In this way, Web App, subsequent MCP, Feishu, Slack, and DingTalk portals will all use the same set of task ingress contracts.
### 5. Data model
It is recommended to add the following general table instead of modifying `users.provider` directly:
#### `ExternalAccount`

Purpose: Bind `Conductor user` to a third-party identity many-to-one.
Suggested fields:
- `id`
- `userId`
- `provider`, the first value of Phase 1 is `FEISHU`, subsequent values ​​are allowed `SLACK` / `DINGTALK`
- `externalUserId`, such as Feishu `open_id`
- `externalUnionId`
- `tenantKey`
- `metadata`
- `createdAt`
- `updatedAt`

Constraint suggestions:
- `@@unique([provider, externalUserId])`
- `@@unique([provider, externalUnionId])`, allows null values
#### `ChannelConversation`

Purpose: Map the chat context of external IM to the conversation/task entry in `Conductor`.
Suggested fields:
- `id`
- `provider`
- `externalChatId`
- `externalThreadId`
- `externalRootMessageId`
- `userId`
- `projectId`
- `taskId`
- `status`
- `metadata`
- `createdAt`
- `updatedAt`

Constraint suggestions:
- `@@unique([provider, externalChatId, externalThreadId])`

illustrate:
- In single chat scenario: `externalThreadId` is empty, `externalChatId` is the only key.
- In group chat scenarios: Prioritize using `chat_id + thread_id` as the session routing key.
- When some providers do not have strong thread semantics, they can be degenerated into `chat_id + root_message_id` or provider-specific conversation key and recorded in `metadata`.
#### `ChannelInbox`

Purpose: First persist the original inbound event, and then process it asynchronously to ensure that the provider callback can ack quickly.
Suggested fields:
- `id`
- `provider`
- `externalEventId`
- `externalMessageId`
- `conversationId`
- `payloadJson`
- `status`
- `error`
- `createdAt`
- `processedAt`

Constraint suggestions:
- `@@unique([provider, externalMessageId])`
- `@@unique([provider, externalEventId])`

Notice:
- For `im.message.receive_v1`, Feishu officially recommends pressing `message_id` to remove duplicates, and do not rely on `event_id`. Therefore, `externalMessageId` is the main idempotent key.
- For other providers, "Business Message Idempotent Key" should also be preferred over "Wrapping Event Idempotent Key".
#### `ChannelOutbox`

Purpose: Reliably push back the provider to avoid synchronous calls to external IM APIs in the hot path of `agent-upstream`.
Suggested fields:
- `id`
- `provider`
- `userId`
- `conversationId`
- `taskId`
- `targetChatId`
- `targetReplyMessageId`
- `targetThreadId`
- `eventType`
- `dedupeKey`
- `payloadJson`
- `status`
- `attemptCount`
- `nextRetryAt`
- `lastError`
- `sentAt`
- `createdAt`
- `updatedAt`

Constraint suggestions:
- `dedupeKey` only
### 6. Provider adaptation strategy
Feishu was chosen as the first adapter, but the core design should allow future access to Slack/DingTalk and other similar enterprise IMs.
Adaptation principle:
- Abstract general session semantics, not abstract provider rich interaction details
- The core only relies on normalized event / outbound contract
- Provider-specific features are exposed through capabilities instead of stuffed into core conditional branches
- Prioritize support for "text message + mention + reply + command" closed loop, and then expand cards and interactions
- For IMs such as Feishu that support both single chat and "multiple topics under a long-term group container", core only expresses `chat` / `thread or topic` / `reply target` and does not hard-code a certain display mode into the schema
General adaptation boundaries for different providers:
- Feishu Adapter
- Phase 1 uses webhooks
- Compatible with `chat_id` / `thread_id or topic_id` / `open_id`
- Adapt reply API and thread reply downgrade
- Slack Adapter
- Adapt to Slack's channel / thread / user identity
- Adapt to bot mention, thread reply, message API and rate limit
- DingTalk Adapter
- Adapt to DingTalk's conversation, group messaging, robot callback and authentication models
- Adapt its reply / card / current limiting strategy
These three types of IM can share most of the state model in the channel core layer, but transport, identity, session and rich interaction details must be retained in the adapter.
### 7. Binding method
MVP does not recommend directly making Feishu a new `User.provider` login method. The reason is simple: the current user table only supports one main provider, and the first requirement for Feishu robot access is to "bind Feishu messages to existing Conductor users", which is not a replacement login system.
MVP recommendation:
- The web side generates a one-time binding code for the logged-in `Conductor` user.
- The user sends `/bind <code>` to the bot in Feishu.
- After gateway verifies the binding code:
- Create `ExternalAccount(provider=FEISHU, externalUserId=open_id, ...)`
- Create or activate the default `ChannelConversation` for the current single chat
Subsequent providers continue the same idea:
- core unified writing `ExternalAccount`
- The adapter decides whether the binding entrance is `/bind`, OAuth, or admin install flow
- `Conductor` login system and channel identity binding system remain separate
Feishu Phase 2 Replenish:
- Feishu OAuth authorization binding
- Web "Connect Feishu" entrance
In this way, the bot control can be run through first, and it will not be blocked by OAuth, scope audit, and single provider user model; and Slack/DingTalk will not need to reversely change the auth backbone in the future.
### 8. Mapping principles from Feishu semantics to Project/Task
In Phase 1, Feishu's chat structure is not directly mapped to `Project`, but is instead mapped to the entry context of `Task` first.
The principles are as follows:
- Feishu users who are not `Conductor User` users must first bind to the existing `Conductor User` through `ExternalAccount`
- Feishu single chat/group chat/topic group topic is not `Project`
- Feishu single chat/group chat thread/topic group topic/root message is closer to a `Task` conversation entrance
- `Project` is still a long-term organizational unit within `Conductor` and should not be reversely defined by the IM session structure
- IM itself does not own task/message, it only maintains "which task is being observed by the current session"
Recommended mapping relationship:
```text
Feishu User -> ExternalAccount -> Conductor User
Feishu Chat / Thread or Topic -> ChannelConversation -> Task
Feishu Message -> Message
Task -> belongs to -> Project
```

Specific implementation:
- Danchao only maintains "current task" semantics by default
- The topic group defaults to `chat_id + topic_id` corresponding to a task context
- Ordinary group chat defaults to `chat_id + thread_id` or `chat_id + root_message_id` corresponding to a task context
- All new tasks initiated by Feishu will be placed in the user's default project by default.
- If the user needs to switch projects, they should use explicit commands instead of automatically mapping chat/group to project
Reasons for this design:
- Keep `Conductor` existing `Project -> Task -> Message` model from being invaded by IM platform structure
- The same Feishu DM is allowed to host multiple tasks sequentially, and the same topic group is allowed to host multiple task topics in parallel, instead of binding the project to the IM container in reverse.
- Let Web and Feishu see the same batch of tasks instead of two different object models
- Decouple the original AI session on daemon/fire from the IM presentation layer. IM only synchronizes the task/message/status that has entered `Conductor`
### 9. Routing rules
#### Private chat
- Key:`chat_id`-Default behavior:
- First non-command message: Create a new task
- Follow-up message: Continue current `ChannelConversation.taskId`
#### Group chat
- Only handle `@bot` messages.
- Routing key priority:  1. `chat_id + thread_id`
  2. `chat_id + root_message_id`
3. If there are none, create a new task for the first mention, and try to uniformly reply to the root message later.
illustrate:
- The above rules are general routing priorities from the core perspective.
- For providers that do not have a strong thread concept, the equivalent `externalThreadId` or fallback key can be generated by the adapter.
#### Topic group
- A topic group is a long-term collaboration container, not a `Project`, nor is it the only entrance to all tasks in the entire system.
- A topic corresponds to a task, and the topic list in the group is the task list under the collaboration scope.
- Routing key:`chat_id + topic_id`
- The group root timeline only undertakes light control and discovery, such as `/new`, `/share <task-id>`, summary and navigation; actual task conversations occur in the corresponding topic.
Reuse boundary:
- The topic group mode of Phase 2 is not a new system, and there is no need to change `Task` / `Message` / agent core.
- It reuses the existing `ExternalAccount`, `ChannelConversation`, `ChannelInbox`, `ChannelOutbox`, `TaskIngressService`, `TaskEventProjector` from Phase 1.
- The main new additions are Feishu Adapter's analysis and pushback of `topic_id`, and product actions for attaching/sharing existing tasks to a certain topic.
- If Phase 1 has modeled `ChannelConversation` and projector as a universal conversation target, then the expansion from 1:1 single chat to topic group should mainly be adapter + routing policy + UX changes, rather than core rewrite.
#### Task mapping
- Defaults to the user's default project.
- Subsequent switching via command:
  
- `/new`
  
- `/task <task-id>`
  
- `/stop`
  
- `/help`

MVP will not do complex command collections for the time being, but first ensure that the task create / continue / stop loop is closed.
#### Relationship between Option 1 and Option 2
- Option 1: Only 1:1 conversation with Feishu robot.
- Option 2: A topic group carries a collaboration scope, and one topic in the group corresponds to one task.
- Option 2 should be built on the same `Channel Gateway Core` of Option 1 without adding a second task/message system.
- Therefore, the implementation of Phase 1 must avoid hard-coding conversation, projector, and reply target into DM-specific models.
### 10. Task List in Feishu

Phase 1 does not reproduce the complete Web task center in Feishu, but provides lightweight task list and task switch capabilities.
MVP command:
- `/tasks`
- `/tasks active`
- `/tasks recent`
- `/task <task-id>`

Suggested semantics:
- `/tasks`
- Display the latest `N` tasks under the current user's default project
- `/tasks active`
- Only displays active tasks under the current user's default project
- `/tasks recent`
- Display recently completed or recently updated tasks
- `/task <task-id>`
- Switch the current `ChannelConversation.taskId` to the specified task
The task list here comes directly from the `Conductor` central library, so:
- Tasks created through the Web will appear in `/tasks`
- Tasks created through IM will appear in `/tasks`
- Tasks created manually through `conductor fire` will also appear in `/tasks`
IM does not distinguish between "Web task / IM task / fire task", it only displays tasks visible to the current user.
The MVP return format recommends using plain text instead of cards:
- Each display `title`, `status`, `short task id`, `updated time`
- Each article has a Web deep link, click to jump back to Conductor Web to view the complete context
- Feishu only provides a light entry point for "selecting and switching current tasks" and does not assume complete task center responsibilities.
`/task <task-id>` not only switches the pointer, but also needs to do an attach / hydration:
- Switch the current `ChannelConversation.taskId` to the target task
- Backfill the latest `N` messages that have been synchronized to `Conductor`
- Backfill current task status and Web deep link
- Then continue to project subsequent messages and status updates of this task
It is not recommended to directly create a card task list in Phase 1 for the following reasons:
- Card interaction is a provider-specific capability and does not belong to the minimum closed loop of the channel core
- The task list itself is a high-frequency browsing capability, and the Web side is more suitable for carrying complete information.
- Text commands are more portable between Slack/DingTalk/Feishu
For topic group mode:
- The topic list in the group naturally serves as part of the task list, so `/tasks` is mainly used in the group to search across topics, view unshared tasks, or attach tasks created by Web/fire to a certain topic.
- Private tasks and unshared tasks are still mainly discovered through DM `/tasks`.
### 11. Inbound and outbound semantics
#### Inbound

After receiving `im.message.receive_v1`:
1. Extract `message_id`, `chat_id`, `thread_id or topic_id`, `sender.open_id`.2. Write `ChannelInbox` first, then use `message_id` to remove duplicates.3. Quickly ack Feishu.4. Asynchronous processing:
- Recognize `/bind`, `/new`, `/task`, `/stop` and other commands.
- If it is a normal message, call `TaskIngressService`:
- New task -> corresponding to `createTaskForUser(...)`
- Existing task -> corresponding to `appendUserMessageToTask(...)`
Additional requirements on the Webhook side:
- The callback handler only does signature verification, decryption, minimum field extraction and `ChannelInbox` drop-in.
- Quickly return a successful response within the provider timeout window
- All business processing is completed in the asynchronous consumer to avoid amplifying external platform retries into the task hot path
For other providers:
- The adapter first normalizes the original payload into `NormalizedInboundEvent`- core only performs binding, routing, command processing and task ingress based on the normalized field
- Complex interaction payloads are reserved in `rawPayload` and `metadata`
#### Outbound

Project from `commitSdkMessage(...)` and `commitTaskStatusUpdate(...)` to `ChannelOutbox`.
Core synchronization principles:
- IM only projects task/message/status that has been synchronized back to `Conductor`
- IM does not directly read the daemon/fire local session file
- The more complete original AI session on daemon/fire remains on the execution side; IM only consumes visible results that have been submitted to the central system
- Once a `ChannelConversation` is attached to a task, subsequent visible updates of the task should continue to be projected to the IM session
Cross-end message synchronization semantics:
- User messages sent by IM do not need to be echoed back to the same IM session after the central library `Message(role=user)` is completed.
- User messages sent by the Web, if the target task is currently attached by an IM session, should be projected to IM, with a source tag if necessary, such as `From Web`
- Assistant message and task status written back by the fire/daemon side. If the target task is currently attached by an IM session, it should be projected to IM.
- Tasks that are not attached to any IM session do not actively push history or new messages to IM; they are discovered through `/tasks`, and then explicitly attached by the user `/task <id>`
MVP only pushes back three types of content:
- assistant final text message- task status changes: `running` / `completed` / `killed`
- Necessary system prompts: unbound, no available daemon, permission restrictions
MVP does not push back:
-Token level streaming output
- High frequency log
- Fine-grained tool call intermediate state
Reason: Most IM single chats/group chats are not terminals. Directly mirroring all intermediate states will quickly increase the message frequency and readability.
### 12. Feishu Adapter Strategy
Feishu Phase 1 uses webhook instead of long connection worker.
reason:
- More in line with `Conductor`'s existing centralized service architecture-Multi-copy deployment and horizontal expansion are more natural
- No need to maintain singleton connections, reconnections and connection keepalives
- The fault domain is smaller, and a single request failure can be solved through provider retry and local inbox idempotence.
MVP uniformly gives priority to "replying messages" rather than "proactively sending new messages":
- Target API:`POST /open-apis/im/v1/messages/:message_id/reply`- reply target：
- Single chat: reply to the latest user message
- Group chat: Prioritize reply to root message / thread
- Topic group: Prioritize replying to topics corresponding to the current `chat_id + topic_id`
Implementation details:
- `ChannelOutbox.dedupeKey` is also used for Feishu reply API's `uuid`, taking advantage of Feishu's 1-hour deduplication capability.
- For group chat thread replies, priority is given to setting `reply_in_thread=true`.
- For topic group mode, the adapter needs to be able to direct outbound back to the topic target corresponding to `chat_id + topic_id`.
- If Feishu returns `230071`, it means that the group does not support thread reply and needs to be automatically downgraded to normal reply and write this capability to `ChannelConversation.metadata`.
### 13. Throttling and aggregation
Feishu officially has a 5 QPS limit for the same user and the same group. MVP needs to explicitly implement two layers of protection:
- `ChannelOutbox` does rate limit for each `targetChatId`- assistant message does short window aggregation
suggestion:
- Merge multiple consecutive `sdk_message` within a 1~2 second window- task terminal status is sent individually and immediately
- Long text plus web-side task link instead of splitting it into multiple pieces to refresh the screen
General principles:
- Current limiting logic can be implemented in the `ChannelOutbox` core layer
- Specific thresholds, error codes and degradation strategies are provided or overridden by the adapter
### 14. Safety and Reliability
#### Constraints that must be adhered to
- Do not bypass `Task` / `Message` / `AgentOutbox` due to IM entry
- Do not expose daemon directly to provider due to IM interaction
- Do not trust any provider as the only source of truth
- Prevent provider-specific conditional branches from invading task core
#### Specific measures
- Inbound idempotent keys use `message_id`- outbound idempotent keys use `ChannelOutbox.dedupeKey` + Feishu `uuid`
- Only accept DMs from bound users, group chat must be `@bot`
- All original payloads are written `ChannelInbox.payloadJson`
- All outgoing failures retain `lastError` and try again
- The webhook handler is only responsible for callback ingress, not task/domain truth
- Webhook requests must be acked within a short timeout, and all actual business processing is asynchronous
## Risks

- If the channel core is too abstract, it is easy to sacrifice clarity for the sake of compatibility with all providers.
- If the channel core is not abstracted enough, Feishu logic will be copied again when Slack/DingTalk is connected later.
- Webhook requires a public network callback address, signature verification, decryption and replay protection, and the access threshold is higher than long connections.
- The webhook must strictly control the ack delay, otherwise it will trigger a provider retry storm.
- Whether group chat supports thread reply is inconsistent and requires capability detection and automatic downgrade.
- If the topic group model does not use `topic_id` as a first-class routing field, it will be forced to change back to the conversation model in Phase 2.
- If the provider pushback is placed directly on the `agent-upstream` synchronization path, external API delays will be introduced into the core hot path.
- The current `User.provider/providerId` model does not support binding multiple external accounts, and `ExternalAccount` must be introduced.
- If aggregation is not performed, `sdk_message` high-frequency pushback will quickly trigger the IM frequency limit and seriously affect readability.
- The capabilities of different providers require an explicit capability table, otherwise the fallback behavior will be scattered throughout the code.
## Rollout

### Phase 0: Extract shared services
- Extract `TaskIngressService`
- Extract `TaskIngressService`
- Definition `NormalizedInboundEvent` / `NormalizedOutboundMessage` / `ProviderCapabilities`
- Ensure that existing Web APIs are migrated to shared services first without changing their behavior
### Phase 1: Feishu Adapter DM MVP

- Added `ExternalAccount` / `ChannelConversation` / `ChannelInbox` / `ChannelOutbox`
- Added binding code process and `/bind`
- Added `Feishu Adapter` webhook ingress
- Support single chat to create tasks, continue tasks, stop tasks
- Push back assistant final message and task status
- At the same time, retain the abstraction of `chat + topic/thread` conversation target, and do not write the schema and projector as DM-only
### Phase 2: Feishu Topic Group Mode

- Support "a topic group carries a collaboration scope, and a topic in the group corresponds to a task"
- Support `chat_id + topic_id` routing
- Support attaching or sharing existing tasks of Web/fire to a topic
- Reuse the inbox/outbox, task ingress, and task projector of Phase 1 without adding a second set of cores
### Phase 2B: Feishu ordinary group chat is compatible with threads
- Support group chat `@bot`
- Support `chat_id + topic_id` routing- thread reply automatically downgrades
- Added `/task` / `/new`
### Phase 3: Core stabilization and more providers
- Extract provider capability registry
- Added Slack Adapter PoC
- Provider-specific supplementary fields required to evaluate DingTalk Adapter
### Phase 4: Experience enhancement
-Support image/file transfer back
- Support card status messages
- Support card-based task list
- Support Feishu OAuth binding
- Supplement richer interaction based on provider capabilities
## Acceptance

- Users can create a new `Task` by sending an ordinary message in Feishu Danchat bot, which can be seen immediately on the web.
- If the user continues to send messages in the same Feishu session, the `Message` list of the same task will be written.
- The assistant message and task status written back by the agent through `/api/agent/events` will receive the corresponding reply in Feishu.
- Tasks created manually through `conductor fire` can be seen in Feishu `/tasks`.
- After the user executes `/task <task-id>` on Feishu, the task will be attached and the recent history and current status will be updated.
- After attaching, if the task subsequently generates a new synchronized message/status on any of Web, IM, and fire, Feishu will be able to see the corresponding projection.
- In the topic group mode of Phase 2, one topic corresponds to one task, and switching to a new topic does not require changing the task core or message core.
- When expanding from the 1:1 single chat mode of Scheme 1 to the topic group mode of Scheme 2, there is no need to rewrite `ChannelInbox` / `ChannelOutbox` / `TaskIngressService` / `TaskEventProjector`.
- When the same Feishu message is delivered repeatedly, the task will not be created or executed repeatedly.
- Existing outbox, retry, stale recovery logic for daemon/fire remains unchanged.
- There is no need to add additional Feishu direct connection code on the CLI/daemon side.
- When adding a second provider adapter, there is no need to modify the task core, agent core or auth main process.
## Open Questions

- Should the Feishu webhook ingress be directly put into the existing `web` service, or split into an independent ingress deployment? My suggestion is: Phase 1 should be placed in the existing `web` backend first, and then split after the throughput and isolation requirements are clear.
- Does Feishu OAuth have to be done in Phase 1 for account binding? My suggestion is: do `/bind` first, and then put OAuth in Phase 4.
- Does group chat allow any bound user to create tasks by default, or does it require a separate group allowlist? My suggestion is: MVP only supports explicit `@bot` and binds the group session to the creator to prevent multiple people from preempting the same task.
- `ChannelConversation` Is it necessary to add an explicit `conversationType` / `providerCapabilitiesSnapshot` field, or should it be placed in `metadata` first? My suggestion is: put `metadata` in Phase 1 first, and then decide whether to solidify the schema when the second provider is connected.
- Whether `topic_id` of Feishu topic group can be stably used as the first-class target field of webhook inbound and outbound replies needs to be confirmed after officially connecting to OpenAPI; if the capability is insufficient, the adapter side fallback key needs to be defined.
- How many recent messages does `/task <task-id>`'s hydration window backfill by default? My suggestion is: backfill the last 10~20 messages first, and then attach a Web deep link to give the complete history.
## refer to
- ChatGPT sharing record:<https://chatgpt.com/share/69b51399-a094-8002-a2da-2d3ca31df5a7>
- Overview of the Feishu incident: <https://open.feishu.cn/document/server-docs/event-subscription-guide/overview>
- Feishu callback overview: <https://open.feishu.cn/document/event-subscription-guide/callback-subscription/callback-overview>
- Feishu "Send callback to developer server": <https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/send-callbacks-to-developers-server>
- Feishu receiving message event: <https://open.feishu.cn/document/server-docs/im-v1/message/events/receive>
- Feishu reply message API:<https://open.feishu.cn/document/server-docs/im-v1/message/reply?lang=zh-CN>
- Get the authorization code from Feishu: <https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code>
- Get `user_access_token`:<https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token> from Feishu
- `Conductor` task ingress：`web/src/app/api/tasks/route.ts`
- `Conductor` message ingress：`web/src/app/api/tasks/[taskId]/messages/route.ts`
- `Conductor` agent upstream：`web/src/app/api/agent/events/route.ts`
- `Conductor` realtime hub：`web/src/lib/realtime/hub.ts`
- `Conductor` durable agent outbox：`web/src/lib/realtime/agent-outbox.ts`
- `Conductor` auth model：`web/prisma/schema.prisma`
