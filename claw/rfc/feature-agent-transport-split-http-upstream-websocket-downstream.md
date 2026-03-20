# Agent Transport architecture reconstruction: HTTP uplink submission + WebSocket downlink push
## state
- Document status:Draft
- Update time: 2026-03-09
## background
Online failures have repeatedly exposed the same type of problems:
- `conductor-fire` has processed the message locally and even generated a reply
- Sometimes the server has received the uplink message and completed the drop-in.
- However, due to websocket jitter, half-closed connection, proxy layer reconnection or ACK return loss, the local may still timeout while waiting for `message_recorded` / `agent_command_ack_recorded`
- The current SDK will upgrade this type of ACK loss to a fatal error, directly interrupting the running task.
This shows that the current architecture couples two things that should be separated:
- "Can the task continue to be executed?"
- "Is the real-time connection stable at this moment?"
This type of coupling will continue to create vulnerabilities in long tasks, tool calls, network flaps, and proxy layer reconnection scenarios.
## Nature of the problem
Currently, key links rely heavily on bidirectional websockets:
- `agent -> server`:`sdk_message`, `agent_command_ack`, status update
- `server -> agent`: user message, stop command, control signal
In order for websocket to be responsible for both "real-time push" and "critical write confirmation", the system has to add:
- stable id
- Idempotent
- ACK
- Resend-reconnect recovery
- Return confirmation
This is theoretically possible, but the complexity is high and the failure semantics are still unnatural:
- Once the ACK return is lost, local execution may fail
- A momentary websocket jitter will be mistakenly amplified into a task-level failure
## Core judgment
The most appropriate long-term direction is not to continue to make websocket a "reliable two-way transaction channel", but to split it according to responsibilities:
- `agent -> server`'s critical write operations are submitted using idempotent HTTP
- `server -> agent`'s low-latency controls and pushes continue to use websockets
- Local execution correctness no longer relies on websocket ACK
This isn't about "getting rid of websocket", it's about returning websocket to a role more suitable for it.
## Target
- Let `conductor-fire` continue to run when the network is temporarily disconnected, the proxy layer jitters, or ACK is lost
- Let critical upstream writes have clear, natural, retryable success semantics
- Make downstream commands have durable delivery and disconnection recovery capabilities
- Reduce the complexity of the application layer ACK protocol
- Improved troubleshooting observability
## non-target
- Does not require the browser UI to still be updated in real time during offline periods
- Does not require complete removal of existing websocket capabilities
- This article does not expand on the mobile/browser transport reconstruction, but only focuses on `conductor-fire <-> server`
## Plan Overview
### 1. Change the uplink key event to HTTP submission
The following messages no longer have websocket ACK as a success condition:
- `sdk_message`
- `agent_command_ack`
- `task_status_update`
- Optional:`task_runtime_status`
It is recommended to converge to one or a group of idempotent HTTP interfaces, for example:
- `POST /api/agent/events`
- `POST /api/agent/messages`
- `POST /api/agent/command-acks`
- `POST /api/agent/task-status`

Whether to split the endpoint can be decided later, but the semantics must be consistent:
- The client carries a stable id
- The server writes idempotently according to the stable ID
- HTTP 200/201 means "submitted"
- When the request fails, times out, or the response is lost, the client directly retries the same stable ID.
### 2. `fire` locally maintains persistent journal / outbox
`conductor-fire` locally maintains disk-level persistent event logs instead of just recording pending in memory:
- Each event is placed on the market first and then submitted to the server asynchronously
- After the disk placement is successful, the main task will continue to execute without blocking it.
- After the submission is successful, mark the local record as committed / flushed
Each local record contains at least:
- `event_id`
- `event_type`
- `task_id`
- `agent_host`
- `created_at`
- `payload`
- `delivery_state`
- `attempt_count`
- `last_attempt_at`

For different events, the stable ID recommendations are as follows:
- `sdk_message`：`message_id`
- `agent_command_ack`：`request_id`
- `task_status_update`:`status_event_id` or `(task_id, seq)`
### 3. The server uses the upstream commit as the true source
The server's processing sequence for agent uplink should be:
1. Verification authentication and idempotent key2. Write events to DB3. Return HTTP success4. Then broadcast to app/browser real-time subscribers
In this way, the messages and status changes seen on the browser side are based on the DB commit, rather than the instantaneous event received by the websocket.
turn out:
- Agent local no longer needs to wait for websocket `message_recorded`
- Even if the broadcast fails on the server side, the correctness of key writing will not be affected.
- The browser/app can directly fill in the status from DB after reconnecting
### 4. Continue to use websocket for downlink, but it must be durable
The `server -> agent` direction continues to retain websocket, the reason is very simple:
- User messages, stopped tasks, tool approvals, etc. need to be pushed with low latency
- Agent resident connections can reduce polling costs
But this link can no longer be "`send()` naked while online".
Should be changed to:
- Server-side maintenance agent command outbox
- Each downlink command has a monotonically increasing `seq`- websocket is only responsible for real-time delivery, not unique storage
- Bring `last_applied_seq` when agent connects or reconnects
- The server automatically replays the `seq > last_applied_seq` command
This means that websocket downstream semantics should change from "send once and forget it" to "command stream replay".
### 5. Downlink ACK no longer uses ACK ACK
Now the problem with `agent_command_ack` is:
- The server sends commands to the agent- agent uses websocket to return `agent_command_ack`
- The server replies again `agent_command_ack_recorded`
- The agent waits for this layer of ACK
This is equivalent to making the acknowledgment link an "ACK of ACKs", which is very fragile.
After transformation, it should become:
- The server sends a command: go to websocket + durable outbox- agent means "I have accepted/executed to a certain step": use idempotent HTTP submission
- The server returns HTTP success and ends the confirmation link.
This confirms that only one layer of the closed loop is retained.
### 6. Browser real-time updates continue to be independent
After the server writes successfully, continue broadcasting to browser/app:
- `task_user_message`
- `task_sdk_message`
- `task_status_update`

This part can still use websockets or SSE.It only affects "when the user sees the change", not "whether the task is executed correctly".
## Key state machine
### Local uplink event status
- `pending_local`
- The order has been placed, but submission has not yet started
- `inflight_http`
- HTTP submission in progress
- `committed_remote`
- The server has been successfully logged into the library
- `retry_backoff`
- The last submission failed, waiting for the next retry
- `failed_terminal`
- The retention limit is exceeded or the payload is illegal, requiring manual intervention.
###Download command status
Server:
- `pending_delivery`
- `delivered_realtime`
- `applied_by_agent`
- `expired` / `cancelled`

agent local:
- `received`
- `applied`
- `reported`

## Why is this more appropriate than "enhancing websocket reliable delivery"
### 1. Failure semantics are more natural
HTTP itself has request/response semantics:
- Success: Server has processed
- Failure: The client can retry directly
In order to achieve the same semantics on websocket, an additional self-built ACK protocol is required.
### 2. Task execution is no longer tied up by ACK return
Whether the local task continues to run depends only on:
- Whether the events to be synchronized have been recorded locally
- Whether the agent main process is still healthy
It no longer depends on whether a certain ACK is returned completely through the websocket and proxy layer.
### 3. The system is easier to observe
You can directly see:
- How many uncommitted events are backlogged locally?
- How many unconsumed commands are backlogged on the server?
- Which task is stuck in the local outbox and which task is stuck in the server outbox
This is more actionable than just seeing an abstract ACK timeout today.
### 4. Complexity is split into the correct position
The system no longer needs a "two-way reliable websocket protocol" to take into account:
- Critical commit
- Real-time push
- ACK
- ACK loss recovery
- Connection status restored
Instead, it becomes two subsystems that are easier to prove correct independently:
- Upstream: idempotent HTTP + local journal
- Downstream: durable outbox + websocket replay
## Recommended interface form
### Solution A: Unified event entrance
`POST /api/agent/events`

Request body instructions:
```json
{
  "agent_host": "conductor-fire-unknown-host-4182584",
  "session_id": "019cd2db-5c5a-7063-b9f2-4bc08cb113a5",
  "events": [
    {
      "event_type": "sdk_message",
      "event_id": "e1475ae1-57f9-4c31-8f19-2c6315f751a2",
      "task_id": "59288f56-811a-4c91-afc2-d4eca5a6ead3",
      "payload": {
        "content": "..."
      }
    }
  ]
}
```

advantage:
- Unified Agreement
- Convenient for batch flush
- Facilitate subsequent expansion of more event types
shortcoming:
- The server-side handler will be more generalized
### Plan B: Split endpoints according to business
- `POST /api/agent/messages`
- `POST /api/agent/command-acks`
- `POST /api/agent/task-status`

advantage:
- handler is more direct
- Permissions and verification are clearer
shortcoming:
- Client synchronizer logic will be more decentralized
Both are acceptable.If long-term expansion and batch submission are more important, I would prefer option A.
## Local storage suggestions
It is recommended to put journal/outbox under fire workspace, for example:
- `.conductor/state/outbound-events.jsonl`
- `.conductor/state/outbound-index.json`

Or use sqlite:
- `.conductor/state/agent_journal.db`

If the event volume is likely to continue to increase, sqlite is more recommended than a pure JSON file.
reason:
- Easier to do idempotent queries
- Easier to do status updates
- Easier to limit volume and clean history
## Migration steps
### Phase 1: Define protocol and stable id
- Stable id rules for solidifying `sdk_message`, `agent_command_ack`, `task_status_update`
- Design HTTP commit API
- Design downlink command `seq`/cursor protocol
### Phase 2: First launch HTTP
- `conductor-fire` adds local journal
- `sdk_message` changed to journal + HTTP flush
- `sdk_message` changed to journal + HTTP flush
- Keep existing websocket downstream unchanged
This is the stage with the greatest benefit, because it first removes the main link that causes the task to crash due to the loss of an ACK backhaul.
### Phase 3: Downlink switch to durable replay
- Strengthen `agentOutbox`
- Introduce per-agent or per-task cursor
- The agent proactively declares `last_applied_seq` when reconnecting
- The server automatically replays missing commands
### Phase 4: Clean up old ACK protocol
- Delete `message_recorded`
- Delete `message_recorded`
- Remove the client's blocking wait for these two types of websocket ACK
## Relationship to existing RFCs
This article is the long-term architectural direction.
The relationship with [feature-agent-websocket-reliable-delivery.md](./feature-agent-websocket-reliable-delivery.md) is as follows:
- The existing RFC addresses "how to make key messages confirmable and resendable within the current websocket architecture."
- This article addresses "Should websocket continue to be responsible for critical upstream submissions?"
There is no conflict between the two:
- In the short term, the existing reliable-delivery RFC can be implemented first to stop bleeding online problems
- Long-term should evolve to the responsibility split architecture described in this article
## Risks and costs
- Need to add a local persistence layer, `fire` will be more complicated
- Need to design HTTP API under agent authentication
- Need to clarify the journal cleaning strategy and disk limit
- Need to handle the UI/diagnostic semantics of "locally executed but unable to submit for a long time"
But the price is worth it, because what they gain is:
- Correctness decoupled from connection state
- More natural crash recovery
- Clearer system boundaries
## Not recommended alternative
### 1. Only increase the websocket ACK timeout
This can only reduce the probability of triggering, but cannot eliminate the wrong architectural boundaries.
### 2. Continue to make all key links into websocket application layer reliable protocols
This will evolve into building a more complex reliable message bus:
- uplink pending
- Downward pending
- ACK
- ACK lost and retransmitted
- Two-way reconnect recovery
- Proxy layer compatible
The final complexity is usually higher than the "HTTP upstream + websocket downstream" split of responsibilities.
### 3. Change all to HTTP polling
This will significantly worsen the latency of downlink commands, resource consumption, and online status experience, making it not worth it.
## in conclusion
From a long-term architecture perspective, the most reasonable direction is:
- Key upstream submissions are idempotent HTTP
- Real-time downlink commands via websocket + durable replay
- `conductor-fire` locally introduces persistent journal/outbox
- Task execution correctness no longer relies on websocket ACK return
This will remove the current problem of "accidental ACK loss leading to task crash" from the root.