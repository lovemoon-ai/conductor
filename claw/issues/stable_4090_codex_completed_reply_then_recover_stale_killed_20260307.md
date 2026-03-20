# stable: codex was recovered but was marked killed by recover_stale after the final state was lost (2026-03-07)

## Symptoms
- The final status of online task `7ba8f205-1a02-4df0-a004-a5f6dd37ad8a` is displayed as `killed`.
- But judging from the message records, the task had continued to produce a large number of `sdk` replies normally before being killed, and the last round of user messages also received corresponding replies.
- From the user perspective: the task content seems to have been carried out normally or even basically completed, but then the task status still changes to `killed`, like "finished but sentenced to death by the system."

## Analysis
- This task uses `codex` backend, `session_id` and `session_file_path` have been dropped into the library, and `sdk` message metadata contains `session_stream=true`, indicating that the session-stream path is working.
- There are `64` messages in the database, including `9` users and `55` sdk. The last user message time is `2026-03-06 22:11:22 CST` and the last sdk message time is `2026-03-06 22:12:22 CST`, indicating that there are no pending users in the last round.
- The outbox records of all user messages are logged by the same fire host `conductor-fire-unknown-host-3707625`, normal `acked`, so this is not a problem of "user messages not being delivered to the worker".
- But the `create_task` outbox record of the task stays at `sent`, `attempt_count=368` for a long time, and the ack has not been completed, indicating that there is a gap in the command confirmation link between fire and the backend.
- Online `conductor.log` also shows that the fire host is repeating `drained outbox ... attempted=3 delivered=0 / attempted=4 delivered=1`, indicating that although this worker can continue to send back `sdk_message`, the outbox/ack status is not stable.
- The task was eventually written as `killed` in `2026-03-06 23:01:12 CST`, and there was no `stop_task` record. This shows that it was not manually stopped by the user, but more like it was automatically recovered by the backend `recover_stale` recovery logic after the fire side was disconnected.
- Taken together, the problem this time is not that `codex` content generation failed, but that "the task was actually restored, but the final state was not stably returned to the backend; after the subsequent fire was dropped, the task still stayed in the non-final state, and was eventually regarded as a lost active task by `recover_stale` and automatically marked as `killed`."