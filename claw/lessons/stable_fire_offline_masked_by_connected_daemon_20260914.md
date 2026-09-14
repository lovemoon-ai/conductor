# stable: fire 离线被在线的 daemon「担保」，任务一直显示 running 但发消息全部 409（2026-09-14）

## 症状

- 生产任务 `a317b3f9`（打印显示器盖子）卡片一直是绿色 `running`，发消息（带图片）连续 409
  `task_missing_active_fire_owner`，重试无效；"Restart AI session" 也 409。
- 同机 `ad5090cb`（mcap可视化）同样状态。两者 `execution_host=NULL`，fire 不在已连接列表。
- 诊断记录：`claw/issues/stable_task_a317b3f9_fire_ws_lost_after_deploy_message_409_20260914.md`。

## 根因

daemon 启动的 ai_task 只能经 fire 自己的 ws 收消息，但两处状态判断把 daemon 在线当成了任务在线：

1. **stale recovery 看错主机**：`recoveryHost = boundHost || executionHost || agentHost`。`executionHost`
   被清空、或启动时绑定按 `agentHost` 恢复后，查的是 daemon。daemon 在线 → 跳过，fire 死活无人再判。
2. **alive_tasks 复活不看 fire**：部署后 fire 没重连 → 被判 `killed/daemon_disconnected`、`executionHost=NULL`；
   daemon 重连推 `agent_alive_tasks`（它只知道 fire 进程还在）→ 撤销成 `running`，`executionHost` 仍为 NULL。
3. 结果是「无主 running」：UI 显示 running，消息路由找不到 fire 一律 409；判死时排给 fire 的 `stop_task`
   发不出去，20 次后进 DLQ。

## 修复

- `web/src/lib/tasks/stale-recovery.ts`
  - 新增 `listDaemonTaskFireHosts`：executionHost / 绑定中的 fire host，外加按 SDK `buildFireHostName`
    规则推导的 `conductor-fire-<daemon>-<taskId>`，`executionHost` 被清空后仍能认出 fire。
  - daemon 启动的 ai_task 按 fire 判活：fire 在线就保留（daemon 离线也不误杀，tmux fire 挺过 daemon 重启）。
  - fire 离线且 daemon 在线：用 daemon 超时（120s）判死，`stop_task` 发给 daemon（进程监护者，能真正杀掉）。
  - 两者都离线：维持原路径，stop 排给 fire。
  - `stop_task` 改用 `enqueueAndAttemptAgentCommand`，在线目标立即投递，不必等 outbox cron。
- `web/src/lib/realtime/agent-gateway.ts` `processAgentAliveTasks`：daemon 启动的 ai_task 仅在其 fire 已连接时才撤销判死，
  并把 `executionHost` 与 hub 绑定指向该 fire；fire 不在线则保持 killed。
- 测试：`stale-recovery.test.ts` 覆盖 fire/daemon 在线四种组合、NULL executionHost 僵尸、超时窗口、PTY 不受影响；
  `agent-gateway.test.ts` 覆盖 fire 离线不复活、fire 在线复活到 fire。新增用例在旧代码上均失败。

## 验证

本地 E2E（worktree server + dev daemon + 真实 fire，`kill -STOP` 冻结进程模拟 ws 断开但进程存活）：

1. daemon+fire 同时冻结 → 判死，stop 排给 fire；只解冻 daemon 并重放 `agent_alive_tasks` → `revoked 0/1`，不再产生无主 running。
2. running + `executionHost=NULL` + fire 冻结 + daemon 在线（生产僵尸现场）→ 判死，stop 立即投递给 daemon 并 acked，
   daemon SIGTERM 无效后 SIGKILL，fire 进程消失。
3. 只冻结 daemon、fire 正常 120s → 任务保持 running，executionHost 不变。

## 如何避免

- 判断「任务是否可用」必须看真正承接消息的那一方；监护者在线只能决定善后动作发给谁，不能替执行者担保存活。
- 任何「撤销判死 / 复活」路径都要同时恢复路由所需字段（这里是 `executionHost`），否则会复活出无法投递的状态。
- 发给「当前在线主机」的命令要走 enqueue-and-attempt，只 enqueue 会依赖 cron 或对端重连才投递。
- 未修复的相关问题：gateway 在 `socket.on("message")` 之前 await 鉴权，连接建立瞬间发送的 `agent_resume` /
  `agent_alive_tasks` 可能被丢弃（本地 E2E 中 daemon 重连后的 alive push 就没有被处理）；fire WS 首次重连无握手超时。
