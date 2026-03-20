# stable: recover_stale accidental fire takeover task review (2026-03-06)

## Symptoms
- User task `6d6c6c5f-d7ed
- 421f-b311
- 0b2b2ec708a1` did not receive an AI reply after the last user message.
- Then the task is automatically marked as `killed`, and the user side shows a session interruption.

## Root Cause
- When the task is created, `tasks.agent_host` records the daemon (such as `m1`).
- After fire takes over, the actual execution host only exists in memory binding (`realtimeHub.taskToAgent`) and is not persisted to DB.
- The recovery logic of `GET /api/tasks?recover_stale=1` only determines and kills according to the offline timeout of `tasks.agent_host`.
- Because the daemon is offline and times out, a manslaughter is triggered, even if the task has been taken over by fire.

## Fix
- Added persistence field `execution_host` (actual execution host) for `tasks`.
- Synchronously update `execution_host` in the fire/daemon binding and running events of agent-gateway.
- The `recover_stale` judgment is changed to `boundHost -> execution_host -> agent_host` to retrieve the recovery host to avoid misjudgment using expired configuration hosts.
- When deleting/stopping tasks, stop target takes priority `execution_host`.
- User message routing fallback host priority `execution_host`.
- Added regression test: `agent_host=daemon` and `execution_host=fire` should not be killed by `recover_stale` when they are online.

## Prevention
- Clear distinction in design:
- `agent_host`: configuration/homed host (for quota and display).
- `execution_host`: Running execution host (used for recovery, routing and stopping tasks).
- For the logic related to "multi-host takeover", there must be a persistent state source and cannot only rely on memory state.
- All recovery automatic actions (auto-kill/auto-recover) must be equipped with "man-kill anti-regression testing".
- Check the `_prisma_migrations` status before publishing involving schema changes to avoid historical failed migrations from blocking the rollout.