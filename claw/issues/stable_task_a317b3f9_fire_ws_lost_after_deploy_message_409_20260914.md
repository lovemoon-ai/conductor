# stable: 任务 a317b3f9 发图片 409 —— 部署后 fire 未重连，任务被「复活」成无主 running（2026-09-14）

- 状态：「无主 running」判定已修（未提交），见 `claw/lessons/stable_fire_offline_masked_by_connected_daemon_20260914.md`；
  fire 为何没重连仍未确认
- 诊断方式：`conductor diagnose --json`（`source=live`）+ 生产 DB 只读查询 + `/opt/conductor/conductor.log`
- 层级：host 绑定层（fire websocket 未恢复）+ web 状态对账（revoke 复活不带 executionHost）
- 同类受影响任务：`ad5090cb-4995-430d-9918-f72657f4c8c1`（mcap可视化，同在 `ubuntu`，时间线一致）

## 结论先行
- **图片上传本身成功**：`task_attachments` 有 `right.webp`（2026-09-14 03:18:40Z，`status=uploaded`，`message_id=NULL`）。
- **失败的是发消息**：`POST /api/tasks/:id/messages`（role=user）→ `resolveTaskUserMessageFireHost` 返回 null
  → `409 task_missing_active_fire_owner`；前端 `features/chat/store.ts` 对该 409 自动重试 ~10s，所以浏览器里连续 9 条 409。
  与是否带图片无关，任何消息都会 409。
- 控制台 `A listener indicated an asynchronous response ... message channel closed` 是浏览器扩展噪音，无关。
- 任务处于**无主 running**：`status=running`、`execution_host=NULL`、`conductor-fire-ubuntu-a317b3f9-…` 不在 connected fire 列表。
  该状态不会自愈，重试没有用。

## 时间线（UTC）
| 时间 | 事件 | 证据 |
| --- | --- | --- |
| 09-12 20:49 / 21:04 | 最后一轮 user → sdk 正常 | diagnose `messages` |
| 09-12 21:41 | 生产部署 0.13.0（`e1e507f`）并重启 web | prod `git reflog` |
| 09-12 21:43:31 | fire 日志 `[fire-ws] Disconnected from backend: reason=connection_lost close_code=1006`，**之后 conductor.log 再无任何行**（无 `Connection failed, retrying`、无 `Conductor connection restored`、无 watchdog） | diagnose `fire_logs` |
| 09-13 04:00:28 | stale recovery 判死：fire host 离线 >30s → `killed/daemon_disconnected`、`execution_host=NULL`，给 fire host 排 `stop_task` | `agent_outbox ea7b6aec…` |
| 09-13 05:28 | 该 `stop_task` 20 次 `Agent offline` → `moved_to_dlq` | 同上 |
| 09-13 07:35:25 | 部署 0.13.1 重启；daemon `ubuntu` 重连推 `agent_alive_tasks`（daemon 仍认为该任务进程存活）→ `processAgentAliveTasks` 撤销判死回 `running`，按设计**不恢复 executionHost** | `tasks.updated_at=07:35:25.603`，`killed_reason` 被清空 |
| 09-14 03:18 | 用户上传图片成功，发送消息 409 ×9 | 用户控制台 + `task_attachments` |

## 未确认点：fire 为什么没重连
- 同一台 `ubuntu` 上部署前启动的其他 daemon-spawned fire（`8f401788`、`857e53f1`、`86c42e1a`、`1ffa0921` 等）都重连成功，所以不是重连逻辑普遍失效。
- 这个 fire 断开后 30h 没写过一行日志；而 SDK 重连失败会每 10s 打 `Connection failed, retrying`（`modules/conductor-sdk/src/ws/client.ts:231`），说明它**没有进入失败重试**。
- 候选：
  1. 首次重连卡在握手：`defaultConnectImpl`（`client.ts:539-549`）没有 `handshakeTimeout`，挂住时持有 `AsyncLock`，fire watchdog 在 `!wsConnected` 时直接 return（`cli/bin/conductor-fire.js:507`），无人兜底。
  2. fire 进程事件循环被阻塞或已退出，但 daemon 仍把它留在 `activeTaskProcesses` 里。
- 需要在 `ubuntu` 上补证（本次无该机器访问权限）：fire pid 是否存活及状态（`ps -o pid,stat,wchan`）、`ss -tnp` 看其到 443 的连接状态（ESTAB 但无升级响应 → 候选 1）、tmux 会话是否存在。

## 暴露的产品问题
1. **revoke 复活出无主 running**：`agent_alive_tasks` 撤销判死时，如果任务是 fire 托管且 fire 不在线，复活后 `execution_host=NULL`，所有 user 消息永久 409。
2. **UI 误导**：重试窗口过后只提示 “Please try again in a moment”，但这个状态重试不会好；“Restart AI session”（refresh_session）也会 409 `Task missing active fire session host`。与 `ui_undeliverable-message-no-failure-indicator-20260913.md` 同源：聊天界面不感知 fire 离线。
3. fire WS 首次重连无握手超时（候选根因，待补证）。

## 为什么 task card 一直显示 running
1. 卡片直接渲染 DB 的 `tasks.status`（`TaskStatusBadge`），不叠加 fire 是否在线；DB 被 07:35 的 revoke 写回了 `running`
   （prod 日志：`agent_alive_tasks revoked 2/15 killed flag(s) for ubuntu (agent_reconnect)`，即 a317b3f9 与 ad5090cb）。
2. 本该再次判死的 stale recovery 看错了主机：`recoveryHost = boundHost || executionHost || agentHost`
   （`web/src/lib/tasks/stale-recovery.ts:158-161`）。`executionHost` 已是 NULL，也没有 fire 绑定（07:35 启动恢复绑定时
   任务还是 killed，不在恢复范围内），于是回落到 `agentHost` = daemon `ubuntu`。daemon 在线 → `:222` 直接跳过，永远不会再判死。

## 修复方向：离线判定按角色区分 fire / daemon，而不是二选一或同时要求在线
| fire | daemon | 现状 | 应当 |
| --- | --- | --- | --- |
| 在线 | 在线 | running | running |
| 在线 | 离线 | running | running（tmux fire 挺过 daemon 重启，`8ad51f3`/`db6f1cd`；若要求两者都在线，每次 daemon 重启/自动更新都会误杀健康任务） |
| 离线 | 离线 | 30s 后 killed，stop_task 发给 fire → DLQ | 同左，stop_task 保留 |
| 离线 | 在线 | **永远 running（本 bug）** | 超过宽限期 → killed/`daemon_disconnected`，stop_task 发给 **daemon**（进程监护者，能真正杀掉半死的 fire 并移出 `activeTaskProcesses`，之后不会再被 `agent_alive_tasks` 复活） |

- 「任务是否活着」只看 fire（daemon 托管的 `ai_task` 只有 fire 能收消息，见 `resolveTaskUserMessageFireHost`）；PTY 任务仍看 daemon。
- 「daemon 是否在线」只决定善后动作发给谁。
- `executionHost` 为 NULL 时仍能判定为 fire 托管：`canFireHostClaimTask` 同款条件（`ai_task` + `agentHost` 是 daemon）。
- `processAgentAliveTasks` 同步收紧：fire 托管任务的 fire 不在线时不撤销判死，否则 daemon 下次重连又会复活。
3. daemon 自己仍把该任务留在 `activeTaskProcesses`，每次重连都会推 `agent_alive_tasks`，就算被判死也会再被复活。

## 用户侧恢复
- 09-14 03:38 UTC 用户已 stop（`stop_task` → ubuntu acked）+ restart（`restart_task` acked），新 fire 连上，
  带图消息 `task_user_message` 03:38:39 acked，任务恢复。遗留：`killed_reason=user_stopped` 在 running 行上未清空。
- `ad5090cb` 仍是无主 running（`execution_host=NULL`），需同样 stop + restart。

先在 UI 停止任务，再 restart（resume in place）。daemon 会重新拉起 fire 并续上 claude session（该任务 09-11、09-12 都走过 `restart_task mode=resume_inplace` 并成功 acked）。恢复后要重新附加图片：未绑定的附件会过期并被清理。
