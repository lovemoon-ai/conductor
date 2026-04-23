# stable: branch/fork successor task 被 reconcile/stale-recovery 误杀 (2026-04-23)

## 症状
1. 从线上任务 `a6b4c109-d824-4093-b707-90da5238eab7` branch 出新任务 `5c6d7e29-3d94-4389-88fc-b1ef8e2ae7d7`
2. 新任务一创建就变成 `killed` 状态，从未真正执行

## 根因

Branch (fork_to_new_task) 创建 successor task 时存在三个 kill 路径的竞态条件：

### 时序

```
1. Restart API 创建 successor task (status="init", agentHost=restartAgentHost)
2. Restart API 写入 agentOutbox (restart_task 消息)
3. Daemon WS 断连 → 重连
4. onConnected 回调触发:
   a. sendAgentResume → processAgentResume → drainAgentOutboxForHost (投递 restart_task)
   b. reconcileAssignedTasks → GET /api/tasks → 对比 activeTaskProcesses → kill 不在本地的 running task
5. restart_task 消息被投递，但 reconcile 先完成 → successor task 被 killed
6. daemon 收到 restart_task 时 task 已经是 killed 状态
```

### Kill 路径 1：`reconcileAssignedTasks` (daemon WS 重连)

- `reconcileAssignedTasks` 获取所有 `agentHost === AGENT_NAME && (status === "unknown" || status === "running")` 的 task
- Successor task 通过 `shouldPromoteInitTask`（`agent-upstream.ts` 中 `commitAgentMessage` 的逻辑：当 task 状态为 `init` 时收到第一条 sdk_message 自动提升为 `running`）可能已被提升为 `running`
- 但 conductor-fire 子进程仍在 spawn 中，尚未注册到 `activeTaskProcesses`
- reconcile 发现 running task 不在本地 → PATCH status="killed"

### Kill 路径 2：`recoverStaleTasks` (daemon 首次连接)

- 与 reconcile 类似，但仅在 daemon 首次连接时触发
- 同样不会排除 `init` 状态的 task

### Kill 路径 3：`stale-recovery` (页面刷新触发)

- `fetchTasks` 默认 `recoverStale=true`
- `recoverStaleDisconnectedAgentTasks` 检查 `!isTerminalTaskStatus` + `!hasAgentHost` + 超时
- Successor task 初始状态为 `init`，不属于终态，会被检查
- Fire host 的 agent 可能还没建立 WS 连接 → 30 秒超时后被 kill

## 修复

### `cli/src/daemon.js` — `recoverStaleTasks` 过滤

排除 `init` 状态的 task，防止 daemon 首次连接时将刚创建的 successor task 标记为 killed。

### `cli/src/daemon.js` — `reconcileAssignedTasks` 过滤

两重保护：
1. 排除 `init` 状态的 task
2. 新增 60 秒宽限期（`RECONCILE_GRACE_PERIOD_MS`）：创建时间在 60 秒以内的 task 不参与 reconcile。覆盖 successor task 已被 `shouldPromoteInitTask` 提升为 `running` 但 conductor-fire 子进程还在 spawn 中的竞态窗口。

### `web/src/lib/tasks/stale-recovery.ts` — `recoverStaleDisconnectedAgentTasks`

排除 `init` 状态的 task。防止页面刷新 `fetchTasks(recoverStale=true)` 时，因为 fire agent 还没建立 WS 连接而在超时后将 successor task 标记为 killed。

## 如何避免

- **自动恢复/对账逻辑必须排除 init 状态**：`init` 状态意味着 task 刚创建，daemon 可能还没收到 `restart_task` outbox 消息，子进程可能还没启动。对 `init` 状态的 task 执行 kill 是不安全的。
- **对账逻辑需要宽限期**：对于刚创建不久的 task（即使状态已变为 `running`），应给予宽限期，避免与 outbox 消息投递竞态。
- **所有 "自动 kill" 路径都应审计**：`recoverStaleTasks`、`reconcileAssignedTasks`、`recoverStaleDisconnectedAgentTasks` 三个路径的过滤条件必须保持一致，任何新增的 kill 路径都必须考虑 init/刚创建 task 的情况。
