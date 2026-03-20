# stable: Diagnosis summary of 4 killed tasks on 4090 (2026-03-10)

## Scope
- Task:
- `459f7f0e-4dfe-415b-8969-e9afb8dadfea`
- `a819f778-41a4-427f-a2ac-7a8ef2d5703b`
- `6781f26a-1711-413d-abd2-17ce3858be33`
- `59288f56-811a-4c91-afc2-d4eca5a6ead3`
- Source of evidence:
- Local daemon log `/home/duino/.conductor/logs/conductor-daemon.log`
- Local `conductor.log` of each task  
- `/home/duino/.conductor/sessions/conductor-ai.top.yaml`
- Online `conductor diagnose <task> --json`
- Among them, `59288`, `a819`, and `6781` reused the analysis that had been done before. This time, `459f` was completed, and the four tasks were unified into a comparison report.

## Conclusion Summary
| task | local execution status | direct cause of death | why `killed` is displayed online | classification || --- | --- | --- | --- | --- |
| `459f7f0e-4dfe-415b-8969-e9afb8dadfea` | daemon creates a new fire workspace | The old version of the SDK throws an error and exits directly after the 30-second ACK timeout of `sdk_message` | The local process `code 1` first, and the server then records the task as `killed` | ACK fatal exit || `a819f778-41a4-427f-a2ac-7a8ef2d5703b` | daemon creates new fire workspace | Same as above, and `agent_command_ack` timeout occurs repeatedly during the entire task | The local process first `code 1`, the final state of the server is `killed` | ACK fatal exit || `59288f56-811a-4c91-afc2-d4eca5a6ead3` | daemon creates new fire workspace | Same as above, the last `sdk_message` returns ACK timeout | The local process `code 1` first, the final state of the server is `killed` | ACK fatal exit || `6781f26a-1711-413d-abd2-17ce3858be33` | Local manual `conductor fire` attach to existing task | Execution side fire host disappears, not ACK fatal crash | Fire host is recovered by stale recovery into `killed` after going offline | Execution side lost connection + stale kill |

## Common conclusion
- Among these 4 items, `3/4` belongs to the same root cause family: the old version of `@love-moon/conductor-sdk/dist/client.js` is actually used at runtime, which treats `sdk_message`'s single ACK miss as a fatal error.
- Old logic in `/home/duino/ws/conductor/cli/node_modules/.pnpm/@love-moon+conductor-sdk@file+..+modules+conductor-sdk/node_modules/@love-moon/conductor-sdk/dist/client.js`:
- `ACK_TIMEOUT_MS = 30000`
- `delete pendingOutbound` after timeout
- Then `reject(new Error(...))`
- Therefore, these three tasks are not "content execution failed", nor are the servers killed first, but the local fire/codex process is killed by ACK timeout first; `killed` is the final state after the server sees the execution side disappear.
- `6781` is another type of problem: the execution side itself disappears first, and then is recycled by the server according to the stale task.
## Diagnosis by task
### 
1. `459f7f0e-4dfe-415b-8969-e9afb8dadfea`

**Local mapping**
- The daemon creates tasks in `2026-03-09 18:52:46 CST`, and the workspace is `/home/duino/ws/fires/2026-03-09/18-52-47_pid_4070088`.
- `conductor-ai.top.yaml` maps to session `019cd23a-9144-7143-b755
- 5bd793c603de`.
**Local execution evidence**- daemon records `Task ... finished with code 1` at `2026-03-10 08:10:11 CST`.
- `agent_command_ack` timeout occurred multiple times during the mission.
- The last crash occurred at the end of the local log:
- The ACK timeout of inbound command `05a9f8b0...` appears first
- Then process user message `2c73333c...`
- eventually throws `Timeout waiting for acknowledgment of sdk_message (a6ceb08b-6417-42bd-9289
- 8c778dd23054)`
**Online final state**
- `conductor diagnose --json` shows that the final task is `killed`, and the update time is `2026-03-10 00:10:12.271Z`.
- The latest user message `2c73333c...` has passed outbox `acked`.
- The latest sdk message `5f976c3c...` has been dropped to the server on `2026-03-10 00:09:42.705Z`.
**judge**
- This is not because the server did not receive the message, nor is it that the user message was not delivered.
- It's more like the server has processed it, but the ACK that returned fire was not received by the client within 30 seconds, and the old version of the SDK is directly fatal.
### 
2. `a819f778-41a4-427f-a2ac-7a8ef2d5703b`

**Local mapping**
- The daemon creates tasks in `2026-03-09 18:52:46 CST`, and the workspace is `/home/duino/ws/fires/2026-03-09/18-52-47_pid_4070088`.
- `conductor-ai.top.yaml` maps to session `019cd23a-9144-7143-b755
- 5bd793c603de`.
**Local execution evidence**- daemon records `Task ... finished with code 1` at `2026-03-10 08:10:11 CST`.
- From the beginning to the end of the task, `agent_command_ack` timeout occurs multiple times, which is not a single incident.
- The connection was restored once midway, indicating that the link itself was not stable.
- The final breaking point is clear:
- The codex reply is still output normally at the end.
- Then it throws `Timeout waiting for acknowledgment of sdk_message (1675036c-876c-45a9-acd7-eee685f6e207)`.
- The stack points directly to the old version of `dist/client.js:512` at runtime
**Online final state**
- `conductor diagnose --json` shows that the final task is `killed`, and the update time is `2026-03-10 00:10:12.271Z`.
- The outbox status of the last user message `877f5da0...` is `acked`, `acked_at = 2026-03-09 15:52:18.055Z`.
- The latest sdk message `6b20a49d...` already exists on the server in `2026-03-09 15:52:32.716Z`.
**judge**
- This task illustrates the problem better than `59288`: ACK return is unstable for a long time, but content generation has been normal until the last `sdk_message` ACK miss was amplified by the old SDK into a fatal exit.
### 
3. `59288f56-811a-4c91-afc2-d4eca5a6ead3`

**Local mapping**
- The daemon creates tasks in `2026-03-09 18:52:46 CST`, and the workspace is `/home/duino/ws/fires/2026-03-09/18-52-47_pid_4070088`.
- `conductor-ai.top.yaml` maps to session `019cd23a-9144-7143-b755
- 5bd793c603de`.
**Local execution evidence**- daemon records `Task ... finished with code 1` at `2026-03-10 08:10:11 CST`.
- `agent_command_ack` timeout appears twice in a row before crashing.
- daemon also reported `reconcileAssignedTasks error: fetch failed` in the same time window, indicating that the link was indeed unstable at that time.
- Finally throws:
- `Timeout waiting for acknowledgment of sdk_message (e1475ae1-57f9-4c31-8f19
- 2c6315f751a2)`
- Also falls on the old version `dist/client.js:512`
**Online final state**
- `conductor diagnose --json` shows that the final task is `killed`, and the update time is `2026-03-10 00:10:12.271Z`.
- The outbox status of the last user message `6a5dd2f2...` is `acked`.
- The latest sdk message `6b20a49d...` already exists on the server in `2026-03-09 15:52:32.716Z`.
- I have separately checked the deeper DB/gateway evidence before: the corresponding `sdk_message` has been stored in the database, and what is lost is the return ACK of `message_recorded` / `agent_command_ack_recorded`.
**judge**
- This task is a standard sample of "Server processed, return ACK lost, client fatal".
- `killed` is not the root cause, it is just the final state after the local fire dies.
### 
4. `6781f26a-1711-413d-abd2-17ce3858be33`

**Local mapping**
- `conductor-ai.top.yaml` records that the task is hung on the local machine `4090`, the project path is `/home/duino/ws/obj-tracking-algo`, and the session is `019cc11a-2faa-7c92-801a-0267b63ed81f`.
- But this is not the fire workspace newly created by the daemon; the local log shows that it is manually `conductor fire` attached to the online task in the existing project directory.
**Local execution evidence**
- `/home/duino/ws/obj-tracking-algo/conductor.log` shows:
- `2026-03-09 21:24:38 CST` attach to task
- `2026-03-09 21:38:58 CST` and the last normal codex reply
- The training product continues to write:
- `history.jsonl` modification time `2026-03-09 21:39:14 CST`
- `history.jsonl` modification time `2026-03-09 21:39:14 CST`
- Didn't see the `sdk_message ACK timeout -> process exited code 1` stack like the other three.
**Online final state**
- `conductor diagnose --json` shows that the final task is `killed`, and the update time is `2026-03-10 00:10:12.271Z`.
- The one that actually executed it at that time was fire host `conductor-fire-unknown-host-4122058`.
- The server records that the host has been disconnected at `2026-03-09 21:39:21 CST`.
- The latest sdk message stops at `2026-03-09 13:38:58.679Z`, there is no pending user, and the existing user outbox is also `acked`.
**judge**
- This task is not an ACK fatal crash.
- It is more like the fire / PTY / shell session on the execution side disappears first, and the server waits until the stale recovery window is opened and then recycles the tasks that are still running into `killed`.

## Root cause merge
### A. ACK fatal strategy of old version SDK
- Affected tasks: `459f`, `a819`, `59288`
- Common characteristics:
- The local daemon records `finished with code 1`
- The local log finally throws `Timeout waiting for acknowledgment of sdk_message (...)`
- Crash stacks all fall on the old version `dist/client.js:512`
- The last user outbox on the server side is `acked`
- The last sdk message on the server side already exists.
- In conclusion:
- The real issue is the reliability of the ACK backhaul link
- What really killed the mission was that the old version of the client upgraded the "single ACK miss" into a fatal exception.
### B. stale recovery kill after the execution side disappears-Affected tasks:`6781`
- Common characteristics:
- Finally, there are normal replies and training product updates locally.
- The server records that the fire host has been disconnected
- There is no pending user and no stop_task
- It took some time before the task was written as `killed`
- in conclusion:
- This type of problem is different from ACK fatal. The root cause is closer to fire session survivability / shell
- PTY life cycle / stale task recycling strategy.

## Follow-up suggestions
1. First ensure that the ACK timeout repair actually enters runtime.
- Just changing `/home/duino/ws/conductor/modules/conductor-sdk/src/client.ts` is not enough.
- Need to rebuild / relink / reinstall so that `cli/node_modules/.../dist/client.js` can also bring new logic.
2. Change the ACK timeout from fatal to recoverable.
- Short timeout only triggers reconnect + resend
- Real failure only occurs when the timeout is long
3. Supplementary observations for the gateway's ACK packet return link.
- Record `sendEnvelope()` sending failure
- Logging websocket `close code/reason`
- Distinguish between "not processed by the server" and "processed by the server but ACK cannot be returned"
4. Supplement `fire` survivability and stale recovery observations separately.
- For tasks such as `6781`, it is necessary to be able to distinguish whether the shell/PTY disappears, the fire process exits, or the agent host is passively disconnected.

## Final conclusion
- These 4 tasks marked as `killed` are not the same type of fault.
- The root causes of `459f`, `a819`, and `59288` are closer to "ACK backhaul link instability + old version SDK fatal exit strategy".
- The root cause of `6781` is "the execution side disappeared first and then was killed by stale recovery".
- Therefore, subsequent repairs cannot only focus on `recover_stale`; a higher priority is to prevent ACK miss from directly killing the fire process and ensure that the repair actually enters the CLI runtime.
