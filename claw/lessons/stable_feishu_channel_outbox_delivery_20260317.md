# stable: Feishutong assistant replied to outbox but the review was not sent (2026-03-17)

## Symptoms
- After the user sends a message in Feishu, the Conductor Web side can see the message and task progress normally.
- The daemon can also be executed normally, and the assistant message has been written to `channel_outbox`.
- But Feishu never received any reply from the robot. It looked like "the message came in, but the robot didn't speak."

## Root Cause
- Feishu originally used `messages/{message_id}/reply` for outbound sending, but the `message_id` obtained from the inbound webhook cannot be stably used as the reply target, and calling the Feishu API will return 400.
- `channel_outbox`'s `dedupeKey` is sent directly as Feishu `uuid`, and the length may exceed Feishu's limit (50 characters), further triggering 400.
- The local/online link mainly relies on cron scanning `channel_outbox` to actually send the message. It lacks the best-effort flush immediately after the message is queued. It is easy to misjudge "reply link is broken" during joint debugging.

## Fix
- Change Feishu's outbound sending to press `chat_id` to directly call `im/v1/messages?receive_id_type=chat_id` to send messages, no longer relying on the reply interface.
- Standardize and truncate Feishu `uuid` to ensure that the length does not exceed 50.
- After the task message is projected into `channel_outbox`, the server immediately triggers a best-effort delivery; cron continues to serve as a backup.
- Supplement and verify relevant tests to ensure that webhook, outbox, and message projection links are stable.

## Prevention
- When connecting to a new third-party IM outbound interface, you must first use a real request sample to verify "whether the inbound message_id can be directly replied to/replyed", and cannot be inferred based on field naming alone.
- Any idempotent key, message ID, token and other fields of the external platform must first confirm the format and length limit, and then map the internal key.
- For outbox type links, the two-layer status of "enqueue" and "delivered" must be checked at the same time during joint debugging to avoid misjudgment that the link is connected only when the link is successfully enqueued.