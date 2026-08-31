# Task / Fire / Daemon 关系模型

这份文档是当前仓库里 `task -> daemon -> fire` 关系的唯一真相源。

它整合并收敛了以下三份历史文档中的有效结论，并且已经按当前代码重新核对：

- `claw/lessons/stable_manual_fire_task_daemon_metadata_binding_20260415.md`
- `claw/lessons/stable_fire_daemon_shared_agenthost_double_init_20260410.md`
- `claw/archived/volc-fire-disconnect-improvement-plan.md`

如果未来代码修改了这里描述的语义，必须同时更新这份文档。

## 1. 范围

这份文档主要描述 `ai_task`。

`pty_task` 也会提到，但它没有独立 fire 进程，模型明显更简单。

这里的几个术语要区分清楚：

- `daemon`:
  常驻本地机器的 `conductor daemon` 进程。
- `fire process`:
  一次具体的 `conductor fire` 进程。
- `fire host`:
  fire 进程连到后端时使用的 WebSocket host 标识，正常形态是 `conductor-fire-<hostname>-<pid>`。
- `manual fire task`:
  直接由 `conductor fire` 自己创建出来的 task。判断标准是 `task.agentHost` 是 fire host。
- `app task`:
  从 App/Web/频道入口创建的 task。判断标准是 `task.agentHost` 不是 fire host。
- `daemon-launched fire child`:
  daemon 为 app task 拉起的子 fire 进程。它是 fire 进程，但它服务的是 app task，不等于 manual fire task。

## 2. 最重要的结论

### 2.1 `agentHost`、`executionHost`、`metadata.daemonName` 不是一回事

- `agentHost`:
  任务的持久化“归属 host / home host”。
- `executionHost`:
  当前或最近一次的实际执行 owner。
- `metadata.daemonName`:
  只用于 manual fire task 的“原始 daemon 关联”，不能拿 `agentHost`/`executionHost` 代替。

这三个字段必须分开看，不能混用。

### 2.2 daemon 和 fire 绝不能共享同一个 `agentHost`

`agentHost` 是后端路由 agent 命令的唯一标识。daemon 和 fire 共用同一个 host，会直接引发：

- `create_task` 被错误进程消费
- `stop_task` 发错进程
- reconnect 时互相抢占连接
- 双重初始化或 kill 失效

当前正确模型是：

- daemon 使用稳定 host，比如配置里的 `daemonName` 或机器 hostname
- fire 使用独立的 `conductor-fire-*` host

### 2.3 当前实现还没有实现 archived plan 里的 owner lease / epoch fencing

`claw/archived/volc-fire-disconnect-improvement-plan.md` 里提到的这些设计：

- `task_owner_lease`
- `owner_epoch`
- `task_command_log`
- “按 `task_id` 而不是 `agent_host` 投递命令”

当前代码都还没有实现。

当前真正在线上生效的 ownership 模型是：

- DB 里的 `task.agentHost`
- DB 里的 `task.executionHost`
- 内存里的 `realtimeHub.taskToAgent`
- `agent_resume` 时的 fire claim 逻辑
- 上游事件进入时的 ownership 校验

不要把 archived plan 里的未来设计写成现状。

## 3. 进程身份和 host 生成规则

### 3.1 daemon host

daemon 的 host 来自：

1. 显式配置的 `daemonName`
2. `CONDUCTOR_DAEMON_NAME`
3. 机器 hostname

也就是说，daemon host 是稳定名字，不带 `conductor-fire-` 前缀。

### 3.2 fire host

fire 通过 `ConductorClient.connect()` 连接后端时，如果没有显式指定 host，会生成：

`conductor-fire-<hostname>-<pid>`

这意味着：

- fire host 默认是进程级唯一的
- fire 重启后 host 会变
- fire host 表示“这一个具体 fire 进程”，不是“某台机器上的 daemon”

## 4. Task 字段语义

`web/prisma/schema.prisma` 里的 `Task` 模型里，和本文直接相关的字段有：

- `taskType`
- `status`
- `agentHost`
- `executionHost`
- `backendType`
- `sessionId`
- `sessionFilePath`
- `launchConfig`
- `metadata`

### 4.1 `task.agentHost`

`agentHost` 是任务的持久化归属 host。

当前语义：

- 对 `app ai_task`:
  `agentHost` 通常是 daemon host。
- 对 `manual fire ai_task`:
  `agentHost` 是 fire host。
- 对 `pty_task`:
  `agentHost` 是 daemon host。

它回答的问题更接近：

- “这个 task 是哪一类 task”
- “默认应该由哪个 daemon 负责 restart / project 相关操作”
- “如果服务端重启，要先把这个 task 重新恢复到哪个基础绑定上”

它不等于“当前一定正在执行这个 task 的进程”。

### 4.2 `task.executionHost`

`executionHost` 是当前或最近一次的执行 owner。

但要注意，当前实现是“乐观写入”的：

- task 创建时就会先写成创建目标 host
- 后续 fire 通过 `agent_resume` claim 成功后，再改成 fire host

所以更准确地说，`executionHost` 表示：

- 当前有效 owner；或者
- 最近一次已经被服务器接受的执行 owner

对 `app ai_task` 来说，它通常会经历：

1. 创建时先写成 daemon host
2. daemon 拉起 fire child
3. fire child `agent_resume`
4. `executionHost` 切到 fire host

对 `manual fire ai_task` 来说，它从创建开始就是 fire host。

### 4.3 `task.metadata.daemonName`

`metadata.daemonName` 只在 manual fire task 上有明确语义：

- 它表示“这个 manual fire task 对应的原始 daemon 是谁”
- 它用于 restart、worktree cleanup、远端 fire log 收集等需要回到 daemon 的操作

它存在的原因是：

- manual fire task 的 `agentHost` 必须保持 fire host
- 但很多 project/worktree/restart 能力仍然属于 daemon
- 所以必须单独持久化一份 daemon 关联

对 app task 来说，通常不需要依赖这个字段，因为 app task 的 `agentHost` 本来就是 daemon。

### 4.4 `realtimeHub.taskToAgent`

`realtimeHub.taskToAgent` 是内存态绑定，不是 DB 字段。

它的语义是：

- 当前 WebSocket routing 层认为“这个 task 正在由哪个 agent socket 处理”

它是临时缓存，特点：

- 服务端重启会丢
- 启动时只会从 DB 的 `agentHost` 做基础恢复
- fire/daemon 重新 `agent_resume` 后会重新纠正

所以它是快速路由缓存，不是最终持久真相。

## 5. 三种 task 的关系矩阵

| 场景 | `agentHost` | `executionHost` | `metadata.daemonName` | 实际进程拓扑 |
| --- | --- | --- | --- | --- |
| app `ai_task` 刚创建、fire 还没 claim | daemon | daemon | 通常为空 | daemon 已收到/即将收到 `create_task`，准备拉起 fire child |
| app `ai_task` 稳态 | daemon | fire host | 通常为空 | daemon 常驻 + 一个 daemon-launched fire child 真正在跑 |
| manual fire `ai_task` | fire host | fire host | 原始 daemon host（如果有 bound project） | 只有这个 fire 进程在跑；daemon 只保留项目关联能力 |
| `pty_task` | daemon | daemon | 无意义 | 只有 daemon / PTY session，没有 fire |

这张表是全文最重要的压缩版结论。

## 6. app `ai_task` 的完整生命周期

### 6.1 创建

App 侧创建 `ai_task` 时：

1. `POST /api/tasks` 先根据 project binding 决定 daemon host
2. 对 bound project，正常要求使用 `project.daemonHost`
3. 创建 task row 时：
   - `agentHost = daemon`
   - `executionHost = daemon`
   - `status = init`
4. `createAndDispatchAiTask()` 会：
   - 持久化 task
   - 先把 `realtimeHub.taskToAgent` 绑定到 daemon
   - 通过 `agent_outbox` 给 daemon 发送 `create_task`

这里要注意：

- app task 不是 fire 自己创建的
- 它的启动入口一定是 daemon

### 6.2 daemon 拉起 fire child

daemon 收到 `create_task` 后：

1. 校验 backend
2. 决定 workspace / cwd
3. `spawn` 一个新的 `conductor fire` 子进程
4. 给子进程注入：
   - `CONDUCTOR_PROJECT_ID`
   - `CONDUCTOR_TASK_ID`
   - `CONDUCTOR_LAUNCHED_BY_DAEMON=1`
5. daemon 自己先上报 task `RUNNING`

这一步的关键点是：

- daemon 负责“拉起”
- 但不负责实际 AI turn 执行
- 真正执行 turn 的是后面的 fire child

### 6.3 fire child claim task

daemon 拉起的 fire child 连上后端后，会发：

- `agent_resume`
- `active_tasks: [taskId]`

服务端在 `bindActiveTasksFromResume()` / `ensureAgentOwnsTask()` 里允许 fire host 对 app `ai_task` 发起 claim，条件是：

- 当前连接方是 fire host
- task 是 `ai_task`
- task 的 `agentHost` 是 daemon，不是 fire

claim 成功后：

- `realtimeHub.taskToAgent` 改绑到 fire host
- `task.executionHost` 更新成 fire host
- `task.agentHost` 保持 daemon 不变

从这一步开始，app task 进入稳态：

- daemon 是“home daemon”
- fire host 是“live owner”

### 6.4 后续消息和状态

fire child 成为 owner 后：

- `sdk_message`
- `task_status_update`
- `task_runtime_status`
- `task_stop_ack`

这些上游事件都应该由 fire host 上报。

服务端会在写入前做 ownership 校验：

- 如果当前 `assignedHost` 不是这个 fire host，且不满足 fire claim 条件，就拒绝
- 这就是最近 kill ownership 修复里那类
  `Task ... is assigned to ..., not ...`
  错误的来源

## 7. manual fire `ai_task` 的完整生命周期

### 7.1 创建

manual fire 不是由 App 先建 task 再派发，而是 fire 自己主动建 task。

流程是：

1. `conductor fire` 先按 project path 解析 project
2. 调 `createTaskSession()`
3. SDK 调后端 `POST /api/tasks`
4. 请求里带上 fire 自己的 `agentHost`
5. 如果当前 project 是 bound project，后端允许 fire host 创建 task，但不会把它伪装成 daemon

创建结果是：

- `task.agentHost = fire host`
- `task.executionHost = fire host`
- `status = running`
- 不会给 daemon 入队 `create_task`

这是 manual fire 与 app task 最大的差异。

### 7.2 daemon 关联如何保存

如果 manual fire task 属于一个已绑定 daemon 的 project：

- 后端会把这个 daemon 持久化到 `metadata.daemonName`

后续 fire 拿到真实 session id 后，又会通过 `bindTaskSession()` 持续把：

- `sessionId`
- `sessionFilePath`
- `backendType`
- `metadata.daemonName`

重新 merge 回 task。

这里必须是 merge，不是 metadata replacement；否则会把别的 metadata 覆盖掉。

### 7.3 为什么 manual fire task 不能把 `agentHost` 写成 daemon

因为如果这么做：

- `create_task` / `stop_task` 都会路由错进程
- daemon 和 fire 会争同一个 websocket host
- reconnect 时会来回 takeover

所以 manual fire task 必须保持：

- `agentHost = fire host`
- daemon 关联单独放在 `metadata.daemonName`

## 8. 命令路由矩阵

下面这张表描述“哪类命令应该打到哪个进程”。

| 命令 | app `ai_task` | manual fire `ai_task` | `pty_task` |
| --- | --- | --- | --- |
| `create_task` | daemon | 不发；fire 自己已在运行 | daemon |
| `task_user_message` | fire host | fire host | 不适用 |
| `stop_task` | 当前 fire owner | fire host | daemon |
| `restart_task` | daemon | 原始 daemon（通常来自 `metadata.daemonName`） | 不适用 |
| `cleanup_task_worktree` | daemon | 原始 daemon | 不适用 |

### 8.1 为什么 user message 要优先发给 fire

App 发消息时，当前实现会优先选：

1. `realtimeHub` 里绑定的 fire host
2. `task.executionHost` 里的 fire host
3. `task.agentHost` 里的 fire host

也就是说，对 `ai_task` 来说，chat message 的目标是“当前 fire owner”，不是 daemon。

### 8.2 为什么 restart / worktree cleanup 要回 daemon

这些操作本质上依赖：

- project binding
- workspace
- git worktree
- daemon 维护的本地上下文

所以它们要回到 daemon，不应该发给 fire。

对 manual fire task，这就是 `metadata.daemonName` 存在的直接原因。

## 9. Stop / Kill 模型

当前 kill 语义已经收敛成：

1. App 把 task 从 `running/init/unknown` 改成 `killing`
2. 记录：
   - `metadata.killingStartedAt`
   - `metadata.killingTimeoutMs`
   - `metadata.killRequestId`
3. 按 `resolveTaskStopTargetHost()` 解析 stop target
4. 发 `stop_task`
5. 只有 fire/daemon 真正上报 `killed` / `completed`，task 才进入终态

### 9.1 stop target 选择规则

当前 stop target 的核心优先级是：

1. `executionHost` 如果是 fire host，优先它
2. 否则 `agentHost` 如果是 fire host，优先它
3. 否则看 `realtimeHub.taskToAgent`
4. 再回退到持久化 host

这保证了：

- app `ai_task` 的 stop 会优先打给 fire child
- manual fire task 的 stop 会打给 fire host
- `pty_task` 才会继续打给 daemon

### 9.2 为什么 daemon 不应该给 fire-managed child 代报终态

当前 daemon 拉起的 app task，本质上是 fire child 在跑。

所以现行规则是：

- daemon 可以报 `RUNNING`
- 但 fire-managed child 的终态应由 fire 自己上报
- daemon 的 child exit 处理要 suppress 这类终态代报

否则会出现：

- task 已经被 fire claim 到 `executionHost = conductor-fire-*`
- daemon 却还用 daemon host 上报 `KILLED/COMPLETED`
- 服务端 ownership 校验直接拒绝

这就是此前 kill ownership bug 的根因。

## 10. Restart 模型

### 10.1 app task restart

app task restart 的 daemon 选择很简单：

- 优先 project binding 的 daemon
- 否则用 task 自己的 daemon host

因为 app task 的 `agentHost` 本来就是 daemon。

### 10.2 manual fire task restart

manual fire task restart 不能直接用 `task.agentHost`，因为那是 fire host。

当前 restart 会按下面顺序找原始 daemon：

1. `metadata.daemonName`
2. `executionHost` 里非 fire 的 host
3. `project.daemonHost`

然后 restart 命令发给这个 daemon。

### 10.3 in-place restart 和 new task restart

- stopped task 且 backend 不变:
  可以 in-place restart
- 其余跨 backend 或 successor 场景:
  由 daemon 创建/恢复新 task

## 11. Worktree / 日志 / 诊断模型

### 11.1 worktree cleanup

worktree cleanup 要找 daemon，不找 fire。

当前 `resolveTaskWorktreeCleanupHost()` 的规则可以概括成：

- 如果当前绑定是 daemon，直接用它
- 如果 task 相关 host 里出现了 fire host，就优先回到 `metadata.daemonName` 或 project daemon

所以：

- app task 的 worktree cleanup 通常回 project daemon
- manual fire task 的 worktree cleanup 依赖 `metadata.daemonName`

### 11.2 远端 fire 日志诊断

诊断收集 fire log 时，也会把以下信息一起作为 daemon candidate：

- `metadata.daemonName`
- `task.agentHost`
- `task.executionHost`
- `realtimeHub` 当前绑定

但会优先过滤掉 fire host，只保留 daemon host 候选。

## 12. 当前实现与 archived plan 的差距

`claw/archived/volc-fire-disconnect-improvement-plan.md` 里的方向是对的，但它描述的是目标架构，不是现状。

当前还没实现的点包括：

- 没有 `task_owner_lease`
- 没有 `owner_epoch`
- 没有真正的 task-level durable command log
- 命令仍然主要通过 `agent_outbox` 按 `agentHost` 投递

所以当前系统真正依赖的是“字段语义 + hub binding + resume claim + ownership 校验”。

这意味着：

- 它已经能区分 daemon / fire / manual fire
- 但还没有做到更强的 lease fencing

后续如果真的上 owner lease，这份文档必须整体改写，而不是局部补丁。

## 13. 不要再犯的错误

### 13.1 不要让 fire 冒充 daemon

错误做法：

- 把 fire 的 `agentHost` 直接设成 daemon 名字

正确做法：

- fire 保持独立 fire host
- 单独持久化 daemon 关联

### 13.2 不要拿 `agentHost` 当 live owner

对 app task 来说：

- `agentHost` 是 daemon
- 真正执行 turn 的是 fire

所以凡是“当前应该把消息/kill 发给谁”的问题，都不能只看 `agentHost`。

### 13.3 不要拿 `executionHost` 当 manual fire 的原始 daemon

`executionHost` 代表 live owner，不代表历史 daemon 身份。

manual fire task 要恢复原始 daemon，只能优先看：

- `metadata.daemonName`

### 13.4 不要把 archived plan 当现网实现

owner lease / epoch 现在还没有。

如果排查线上问题，必须按当前真实代码模型分析：

- `agentHost`
- `executionHost`
- `metadata.daemonName`
- `realtimeHub.taskToAgent`
- `agent_resume`

### 13.5 不要拿单进程内存当 task 存活判定（已修复，机制见下）

daemon 有两处会把 task 判成 stale 并 PATCH `killed`：

- `recoverStaleTasks()` —— daemon **启动**路径，无宽限期
- `reconcileAssignedTasks()` —— WS **重连**路径，有 60s 宽限期

历史上两处都**只看单进程内存**（`activeTaskProcesses` / `activePtySessions`），
不查真实执行载体。但 `fire_tmux_mode` 下 daemon 关闭时是**故意**保留 tmux Fire 的
（`leaving tmux-detached Fire task ... running`），新进程的内存表必然为空 ——
于是 daemon 重启会杀掉上一个 daemon 刻意保留的 Fire。复发三次
（20260723 / 20260731 / 20260831）。

现在的模型是**认领（adopt）而不是跳过**：

1. spawn 每个 tmux Fire 时，把 reaper 判定终态所需的字段落盘成一份
   **hand-off record**：`$CONDUCTOR_HOME/daemon/fire-sessions/<session>.json`
   （`cli/src/fire-session-registry.js`）。关键是 `exitMarkerToken` —— 它是
   per-spawn 随机 nonce，跨进程不可复现，不落盘就永远读不回退出码。
   记录以 **tmux session 名**为 key，因为 session 名是继任 daemon 唯一能枚举的
   标识；**session 名不能反解出 task id**（`buildFireTmuxSessionPrefix` 把 task id
   截断到 32 字符，短于 UUID）。
2. 启动时 `adoptOrphanedTmuxFires()` 枚举 `conductor-fire-*` 会话，按记录重建
   record 并注册回 `activeTaskProcesses`，于是 liveness reaper 照常盯着它。
   这一步在 `client.connect()` **之前**发起，两处 stale 判定都 `await`
   同一个 promise 后才动手。
3. 两处判定路径还会各自查一次 tmux，并对没有 hand-off record 的会话**就地认领**
   （降级模式：只有后端此刻才告诉我们 task id）。降级 record 标
   `adoptedWithoutMetadata`，会话消失时如实上报 KILLED——沉默会让任务永远卡在
   `running`，因为除了 reaper 没人盯着被认领的会话。
4. 会话还活着但记录里的 exit marker 已写出 = **壳活 fire 已死**的孤儿会话：
   杀掉壳、删记录，让正常 stale 流程上报终态。认领它反而会让任务永久 `running`。

护栏：整条路径由 `FIRE_TMUX_MODE_ACTIVE` 把关，非 tmux 部署行为不变。
回归测试 `cli/test/daemon-tmux-adoption.test.js` 固化了三个场景（会话存活 /
无会话 / 孤儿会话）× 两条 kill 路径 —— **只修 `reconcileAssignedTasks` 一处会被
测试抓住**，这正是前几次差点漏掉的地方。

### 13.6 §2.2 同样适用于"两个 daemon"，不只是 daemon vs fire

两个 daemon 用同一个 `daemonName` 连同一后端时，后端每个 agent 只保留一条 WS，
新连接顶掉旧连接，被顶掉的重连再顶回去 —— 形成秒级乒乓风暴
（`close_code=1005`、`last_presence_at=never`）。叠加 13.5 修复前的内存式判定，
"重复上线"会被直接放大成"批量误杀"。13.5 的认领机制消掉了放大器，但
**顶号本身仍未治理**：后端对同名 `daemonName` 重复上线依旧静默顶号，需单独立项。

排查指纹：日志里 `localActive=0 markedKilled=N` 与 `backendAssigned=0 localActive=N`
两种视角交替出现。确认手段是 `lsof -nP -p <pid> -a -i` 数有几个进程连着生产，
再 `ps eww` 看它们的 `CONDUCTOR_*` 环境。

详见 `claw/lessons/stable_test-spawned-rogue-prod-daemon-mass-kill-20260831.md`。

## 14. 代码锚点

下面这些文件是当前模型的关键实现点：

- daemon host 解析：
  `cli/src/daemon.js`
- tmux Fire 跨 daemon 认领 + hand-off record：
  `cli/src/daemon.js`（`adoptOrphanedTmuxFires` / `adoptLiveTmuxFireForTask`）
  `cli/src/fire-session-registry.js`
- fire host 解析：
  `modules/conductor-sdk/src/client.ts`
- manual fire 创建 task：
  `cli/bin/conductor-fire.js`
  `web/src/app/api/tasks/route.ts`
- app task 创建和 `create_task` 派发：
  `web/src/lib/tasks/create-ai-task.ts`
  `cli/src/daemon.js`
- fire claim ownership：
  `web/src/lib/realtime/agent-gateway.ts`
  `web/src/lib/realtime/agent-upstream.ts`
- stop target 解析：
  `web/src/lib/tasks/task-stop.ts`
  `web/src/app/api/tasks/[taskId]/route.ts`
- restart daemon 解析：
  `web/src/app/api/tasks/[taskId]/restart/route.ts`
  `web/src/lib/tasks/inplace-restart.ts`
- worktree cleanup daemon 解析：
  `web/src/lib/tasks/worktree.ts`
- runtime binding 缓存：
  `web/src/lib/realtime/hub.ts`

## 15. 一句话版

一句话总结当前模型：

- app `ai_task`:
  `agentHost = daemon`，`executionHost = fire`
- manual fire `ai_task`:
  `agentHost = fire`，`executionHost = fire`，`metadata.daemonName = original daemon`
- `pty_task`:
  `agentHost = daemon`，`executionHost = daemon`

如果这三句话对不上代码，就说明代码或这份文档有一个已经过时了。
