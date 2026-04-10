# Fire 与 Daemon 共享 agentHost 导致 Codex 双重初始化和 Kill 失效

## 日期
2026-04-10

## 症状
1. 线上任务 `a723de46-7033-4e34-9205-15e29231f639` 的 Codex session 被初始化了 2 次
2. 手动 fire 的任务，在线上 kill + remove 后，本地 fire 进程没有自动退出

## 根因

commit `ec3c92a`（"add configuredDaemonName to agentHost"）将 fire 进程的 `agentHost` 设为与 daemon 相同的 `configuredDaemonName`，导致 fire 和 daemon 共享同一个 WebSocket 路由标识。

`agentHost` 是服务器路由所有 agent 命令（`create_task`、`stop_task` 等）的唯一标识。两个进程共享同一个 `agentHost` 会引发：

### 问题 1：Codex 双重初始化

1. Fire 进程通过 HTTP POST /api/tasks 创建任务
2. 服务器将 `create_task` 命令入队 agent_outbox，投递给 `agentHost`
3. Fire 的 SDK 收到 `create_task` 但不识别（只处理 `task_user_message`/`task_action`/`stop_task`），静默忽略
4. Outbox 标记为 `status="sent"`
5. Daemon 自动重连 → `drainAgentOutboxForHost(ignoreRetryAt: true)` → 重投 `create_task`
6. Daemon 处理 `create_task` → 启动子进程 → **Codex session 第二次初始化**

### 问题 2：Kill 后 fire 不退出

1. Fire 和 daemon 通过 `takeOverAgentHost` 互相踢对方的 WebSocket 连接（ping-pong）
2. 用户点击 Kill 时，`stop_task` 路由给 `agentHost`，可能被 daemon 接收
3. Daemon 查 `activeTaskProcesses` 无此任务 → `sendStopAck(false)` → outbox 标记已 ack
4. Fire 从未收到 `stop_task`，永远卡在 `while (!this.stopped)` 循环
5. 随后 Remove (DELETE) 时 task 已被 kill（`needsStop=false`），不再发送 `stop_task`

## 修复

### 客户端 (`cli/bin/conductor-fire.js`)

删除 `agentHost: configuredDaemonName || undefined`，fire 恢复使用独立的 `conductor-fire-{hostname}-{pid}` 作为 agentHost。

### 服务端 (`web/src/app/api/tasks/route.ts`)

ec3c92a 的原始目的是解决 fire 无法在 daemon 绑定的项目上创建任务的问题（两个 409 校验拦截）。正确的修法是在服务端对 fire host 放行：

1. **daemon 在线检查**：当请求方是 fire host 时跳过 `projectDaemonHost is offline` 检查
2. **agentHost 匹配校验**：当 `agentHost !== projectDaemonHost` 但 `isConductorFireHost(agentHost)` 为 true 时，保留 fire 自己的 agentHost，不覆盖为 daemon host
3. **跳过 create_task 入队**：fire host 自己运行任务，不需要通过 outbox 派发 `create_task`，避免 daemon 误处理

## 如何避免

- **agentHost 是路由标识，不能共享**：不同进程必须使用不同的 agentHost。如果需要关联 fire 和 daemon，应通过 metadata（如 `metadata.daemonName`）而非共享 agentHost。
- **修复校验问题应在校验层解决**：当服务端校验拦截了合法请求时，应修改校验逻辑，而不是让客户端伪装身份来绕过校验。
