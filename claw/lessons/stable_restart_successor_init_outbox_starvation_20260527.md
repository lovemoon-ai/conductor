# stable: restart successor task stuck in init from outbox starvation (2026-05-27)

## Symptom

Using `New task from this` on an existing AI task created a successor task that stayed in `init`.

Example: online task `88c4361c-e87b-4283-9cb7-30b91ca21a4a` was created at `2026-05-27T15:47:25.491Z`, bound to online daemon `m1`, and only contained the handoff notice message. Remote log collection returned `Task not found in session store`, so the daemon never started a local fire session for that successor task.

## Root Cause

The restart route enqueues a `restart_task` command in `agent_outbox`, then asks the realtime outbox delivery helper to drain commands for the daemon.

`deliverAgentOutboxForHost` ordered all `pending` and `sent` rows by oldest `createdAt`. Production had many old `sent` command rows for deleted tasks. The daemon kept receiving those old commands and acking/rejecting them, but the server refused to record the ack because the referenced task row no longer existed. Those old rows stayed in `sent`, kept retrying, and starved newer `pending` restart commands behind the batch limit.

## Fix

- Deliver the newly-created successor's own `restart_task/fork_to_new_task` outbox row immediately instead of starting it through a host-wide drain. Failed delivery remains durable and retryable through the outbox.
- Prioritize `pending` outbox rows before `sent` retry rows when draining a host, so fresh commands are not blocked by old ack cleanup.
- Allow `agent_command_ack` for a deleted task to close the durable outbox row when the ack matches the original `requestId`, `taskId`, `agentHost`, and command type. Existing tasks still go through the normal ownership checks.

## Avoid Next Time

- Durable command queues must not let old retry cleanup block newly enqueued commands.
- User-triggered creation of a new runnable task should attempt its own startup command directly rather than depending on unrelated host backlog.
- Ack paths for durable commands should be able to retire commands whose target entity was deleted after delivery, as long as the ack matches the original durable row.
- Diagnostics for task startup issues should inspect non-user command rows such as `restart_task`, not only `task_user_message`.
