# stable: agent websocket messages are not confirmed or are repeatedly entered into the database for review after reconnection (2026-03-08)

## Symptoms
- Users occasionally encounter two types of problems after the daemon/fire and server-side websocket are briefly disconnected:
- The `sdk_message` sent by the SDK has been sent locally, but the app side has not received the corresponding reply, which appears as "the message seems lost"
- When re-sending the same message after reconnection, the server may be dropped repeatedly and duplicate messages may appear on the chat page.
- User side results are usually:
- The last message was not processed correctly after the session was restored
- Receipts for commands such as stop/task action are occasionally lost, and the backend mistakenly thinks that the agent has not confirmed it.
- The stability of reconnection scenarios is significantly worse than that of regular online links

## Root Cause
- In the old implementation, `sdk_message` and `agent_command_ack` are both "successful once issued", lacking backend confirmation semantics.
- When the websocket is disconnected, the SDK does not retain the message to be confirmed, nor does it automatically resend it after reconnect.
- There is no stable client ID when the server drops the library `sdk_message`, and the same message after retry cannot be idempotent.

## Fix
- The SDK side adds a confirmable sending queue for `sdk_message` and `agent_command_ack`, and waits for the backend ack after sending.
- Automatically flush the pending confirmation message after websocket reconnect to ensure that it can still be reissued after a short disconnection.
- The server adds `client_message_id` to `sdk_message` and drops it into the unique constraint. Repeated delivery will only return `message_recorded` and no more repeated broadcasts.
- Added SDK/web tests to cover stop ack, message confirmation and confirmation link after reconnection.

## Prevention
- For all key business events across websockets, the design phase must clearly define three things: "delivery confirmation", "retry" and "idempotent keys". You cannot just do fire-and-forget.
- The reconnect scenario must be tested separately from the normal online link, especially boundaries such as "last message" and "last ack".
- Any event that is planned to ensure reliability through retry must first define the server-side deduplication key and then implement retransmission.