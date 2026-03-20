# Agent WebSocket reliable delivery minimal implementation solution
## background
Note: This article focuses on the short-term hemostasis of "complementing reliable delivery within the existing websocket architecture". If you redo the transport responsibility split from the long-term architecture, see [0005-feature-agent-transport-split-http-upstream-websocket-downstream.md](./0005-feature-agent-transport-split-http-upstream-websocket-downstream.md).
The online mission `562df949-3c10-4ade-a3ee-9c436650af7f` exposed a clear problem:
- fire has processed user messages locally and generated AI replies
- But within the backend restart/websocket jitter window, this `sdk_message` did not fall stably to the server.
- At the same time, the corresponding `agent_command_ack` has not been stably dropped into the library.
- In the end, the backend cannot see the reliable execution side survival and consumption progress, and automatically recycles the task into `killed` according to stale
The current websocket link supports automatic reconnection, but does not support reliable recovery "without losing messages during the backend restart process".
## Nature of the problem
Now the key message sending semantics of `fire -> backend` are:
1. The websocket connection is open2. `send()` Success3. The client considers the sending to be successful.
This does not mean "the backend has reliably received and dropped the library". The real failure window occurs after `send()`, for example:
- Just after the local `send()` was completed, the connection was immediately disconnected and the server did not receive it at all.
- The server received it, but restarted before writing to DB.
- The server has written to the DB, but the confirmation message has not been returned to the client. The client does not know whether to resend it.
So just "make sure the connection is reliable before sending" is not enough. What is really needed is:
- Wait when connection is not restored
- Wait for application layer confirmation after sending
- Unconfirmed messages will be resent after reconnection
- The server is idempotent based on stable IDs to avoid repeated logging.
## Target
First, we will only complete the reliable delivery of the two most critical types of messages:
- `sdk_message`
- `agent_command_ack`

Not processed yet:
- `task_runtime_status`
- `task_status_update`
- `heartbeat`

reason:
- `sdk_message` is lost, users cannot see the reply directly.
- If `agent_command_ack` is lost, the outbox will remain unconsumed, triggering repeated delivery and status drift.
- These two main links have covered the current online fault
## Minimal implementation
### 1. `sdk_message` introduces client stability `message_id`
When the current server drops the library `sdk_message`, use the server to generate the id.Need to be changed to allow fire/SDK to ship with a stable client `message_id`:
- Generate uuid when sending for the first time
- Continue to use the same `message_id` when retransmitting after reconnecting
In this way, the server can recognize the same reply idempotently.
### 2. The server makes `sdk_message` idempotent by `message_id`
When agent websocket gateway handles `sdk_message`:
- If `message_id` appears for the first time, write `messages` normally
- If the same `message_id` already exists, directly return the "recorded" confirmation without repeated insertion.
suggestion:
- Add the `client_message_id` field to the `messages` table and establish a unique constraint
- The server `message_recorded` returns `message_id` as it is in the receipt.
In this way, the client can match the "server confirmation has been dropped" with the local pending message.
### 3. `agent_command_ack` continues to reuse `request_id`
`agent_command_ack` Now naturally has stable `request_id`.This link does not need to introduce a new ID, and only needs to truly include "server confirmation and dropout" into the client's success conditions.
The server can continue to return `agent_command_ack_recorded(request_id)` in the existing way.
## 4. `ConductorClient` adds confirmable outbound queue
Maintain pending confirmable outbound map inside SDK, covering only:
- `sdk_message`
- `agent_command_ack`

Each message to be confirmed saves at least:
- type- payload
- Stable id (`message_id` or `request_id`)
- Time of first delivery
- Last sent time
- Current number of retries
Change the sending process to:
1. If the websocket is not currently connected, wait for the connection to be restored first.2. Send the message after the connection is restored3. Add the message to the pending map4. Wait for server application layer ack5. After receiving the ack, delete it from the pending map and resolve6. If no ack is received after timeout, it will not be regarded as successful. It will be kept in the pending map and will be retransmitted after the next reconnection.
## 5. Automatically resend unconfirmed messages after reconnection
After successful websocket reconnect:
- In addition to existing `agent_resume`/recovery logic
- Then `ConductorClient` automatically resends all unconfirmed confirmable outbound messages
Resend must use the original stable id:
- `sdk_message.message_id`
- `agent_command_ack.request_id`

In this way, the server can safely handle idempotence.
## Interface constraints
To keep implementation boundaries clear, it is recommended that:
- websocket connection management is still responsible for `modules/conductor-sdk/src/ws/client.ts`
- The life cycle of "confirmable message" is responsible for `modules/conductor-sdk/src/client.ts`
- `conductor-fire` The calling side tries not to perceive the retry details and still only calls `sendMessage()` / `sendAgentCommandAck()`
In other words, reliable delivery should converge at the SDK layer instead of being scattered in the fire business logic.
## Recommended modification range
### SDK

- `modules/conductor-sdk/src/client.ts`
- `sendMessage()` changed to "Send and wait for `message_recorded`"
- `sendMessage()` changed to "Send and wait for `message_recorded`"
- Add pending outbound queue
- Consume receipts and resolve pending in backend event handler
- `modules/conductor-sdk/src/ws/client.ts`
- Expose the reconnect success timing to the upper layer
- Support the upper layer to uniformly flush pending outbound after reconnect
### Web / Agent Gateway

- `web/src/lib/realtime/agent-gateway.ts`
- `sdk_message` routing supports client incoming `message_id`
- `sdk_message` is dropped according to `message_id` idempotent
- `message_recorded` brought back `message_id` in the receipt
- `agent_command_ack_recorded` maintains existing semantics, ensuring `request_id` can be used for client matching
### Prisma / DB

- `web/prisma/schema.prisma`
- `Message` adds `clientMessageId` (or equivalent name)
- Add unique index
- Need to evaluate production database migration simultaneously
## Not recommended solution
### Only wait for "connection stable" before sending
This solution is not enough to solve the problem because the failure window occurs after `send()`.Even if the websocket was open at the time, it does not mean that the server has processed it and dropped it into the library.
### Reliably confirm all websocket messages one by one
It is not recommended that the first version make `task_runtime_status`, `heartbeat`, etc. reliable news:
- high cost
- Will increase the confirmation wait under a large amount of normal traffic- is not the critical path of the current online incident
The first version only covers `sdk_message` and `agent_command_ack`, with the highest benefits and the lowest risks.
## Delay impact
This solution will add a small amount of normal link delay:
- Before: `send()` returns on success
- After that: need to wait for server application layer ack
Under normal circumstances, this is just one more websocket RTT, usually tens of milliseconds to one or two hundred milliseconds.Compared with the time consuming of model generation and tool execution, this overhead is usually acceptable.
It will be slower under abnormal circumstances because:
- When the backend is restarted or 502 is received, the client will wait for confirmation or reconnection
- This is not a new disadvantage, but changing "false success" to "real waiting"
## Testing suggestions
Cover at least the following scenarios:
1. `sdk_message` is sent successfully for the first time, the server drops the library and returns `message_recorded`2. The connection was interrupted after `sdk_message` was sent, and the server did not confirm it. After reconnecting, the resend was successful.3. `sdk_message` has been dropped into the library but the ack is lost. The client resends and the server handles it idempotently as `message_id`.4. `agent_command_ack` will be resent after reconnection, and the server will not consume it repeatedly.5. When the websocket flaps briefly, the user can only see one AI reply in the end, and the outbox is only acked once.
## Subsequent expandable items
After the first version is implemented, you can continue to consider:
- Include `task_status_update` into confirmable outbound
- Put pending outbound to disk to solve the recovery problem after the fire process itself crashes
- Add monitoring indicators for confirmable outbound:-pending quantity- ack timeout number-Number of retransmissions after reconnect
- Number of idempotent hits
## in conclusion
To achieve "no message loss during backend restart", the minimum correct solution is not to simply wait for the websocket to be connected, but to:
- wait for connection
- send with stable id
- wait for application-level ack
- resend after reconnect
- dedupe on server

The first version only works on `sdk_message` and `agent_command_ack`, which is enough to cover the main faulty link currently exposed online.
