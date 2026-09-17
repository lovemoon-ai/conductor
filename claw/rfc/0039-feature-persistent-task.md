# 0039 常驻任务（persistent task）：一个 Task，多轮全新 AI session

## Status

Implemented（2026-09-17，web + daemon；本地 E2E 已验证）

## Owner

dang217

## Date

2026-09-17

## Summary

有些工作是周期性的（两周一次发版、定期 Research）。今天一个 `ai_task` 严格绑定一个 AI session：要么一直复用同一个 session，历史越积越多、Token 越烧越多；要么每次新建 task，Conductor 里的记录被拆散。

本 RFC 给普通 Task 加一个「常驻」开关。常驻任务和普通任务同一级别（标签、分享、搜索、定时消息、打包、配额都不变），只是多了「轮次」：

- **结束本轮**：让当前 AI 写一份滚动总结，本轮进入空闲。
- **开新一轮**：停掉旧 fire，在**同一个 task id** 上起一个**全新的 AI session**（不 resume），每轮可重新选 backend / daemon / worktree。新一轮的第一句 prompt = 固定说明 + 上一轮总结 + 用户消息，不带完整历史。
- Conductor 里的聊天记录是连续的，旧轮次默认折叠。

不改数据库 schema。daemon 只加一个向后兼容的 `create_task` 字段（见 §4）。

## Context

- `Task.sessionId` 是 task 与 AI session 的唯一绑定。现有 restart 的三条路径都不满足需求：
  - `inplace` restart：服务端要求已有 `sessionId`（`restart/route.ts:243`），daemon 永远 `--resume`（`daemon.js handleRestartTask`）。
  - `refresh_session`：fire 内重建进程，仍 resume 同一个 session。
  - `new_task` successor：新建 task，把完整历史的分享链接交给新 AI，记录拆成两个 task，也不省 Token。
- daemon 的 `create_task` 只看 `task_id / backend_type / initial_content / launch_config / request_id`，不关心这个 task id 之前是否跑过；fire 启动时只 `getTask` 校验存在。所以对**已有 task** 再发一次 `create_task` 就是"全新 session"。
- `status: "init"` 的 task 会被 daemon reconcile 跳过（`daemon.js` reconcile），第一条 SDK 消息到达时 `commitSdkMessage` 把它提升为 `running`。
- AI 回复都经过 `commitSdkMessage`（`agent-upstream.ts`），`metadata.reply_to` 指向触发它的用户消息 id。
- 任务列表排序集中在 `orderTasksWithPinnedFirst`（store、TaskList、手机端滑动切换共用）；过滤链有三处：`TaskList.tsx`、`app/tasks/page.tsx`（计数）、`task-list-navigation.ts`（滑动顺序）。
- `project.metadata` 每个用户一行（协作者各有自己的 project 行），适合放按人按项目的显示开关。

## Goals

- 普通 task 可以在创建时或之后切换为常驻；关掉常驻即回到普通 task，历史保留。
- 结束本轮时由 AI 生成滚动总结；AI 已停止时跳过，允许手写 / 修改。
- 开新一轮 = 同一个 task 上的全新 AI session，第一句 prompt 只带固定说明 + 上一轮总结。
- 每轮可选 backend、daemon、worktree（沿用 / 新建 / 不用），默认沿用上一轮。
- 空闲时直接发消息 = 用上一轮设置开新一轮，这条消息作为第一句话。
- 列表中常驻任务**置底**；Project 上可按人关闭"显示常驻任务"。
- 聊天里旧轮次默认折叠，展开可看完整消息。

## Non-Goals

- 定时自动开新一轮（以后可接 ScheduledMessage）。
- 单独归档某一轮；整个 task 仍用现有打包（achieve）。
- 在 CLI / SDK 里暴露轮次操作。
- 旧轮次 worktree 的自动清理。

## Options Considered

### Option A：父子 Task（常驻任务是容器，每轮是一个子 `ai_task`）

- Pros：每轮边界清楚，可单独诊断。
- Cons：聊天页要跨多个 task 拼消息，状态、未读、发消息都要转发到当前子任务；列表、计数、分享、搜索、配额都要处理子任务，改动面大。

### Option B：一个 Task 里放多个 session（选定）

- Pros：聊天记录天然连续，列表 / 分享 / 搜索 / 配额零改动；复用 `create_task` 即可起全新 session。
- Cons：每轮的 session 信息只留在分隔消息里，不适合做按轮统计。

## Proposed Design

### 1. 数据（`task.metadata.persistent`，无 schema 变更）

```json
{
  "persistent": {
    "enabled": true,
    "instructions": "固定说明（可空）",
    "summary": "最新的滚动总结（可空，可手改）",
    "round": 3,
    "roundEndedAt": "2026-09-17T10:00:00.000Z",
    "roundEndMessageId": "msg-id"
  }
}
```

- `round` 缺省为 1。`roundEndedAt` 非空表示本轮已结束（空闲）。
- `persistent` 在 task PATCH 中是 sticky 字段：本次请求显式带 `persistent` 则以请求为准，否则保留，避免 daemon 的 `metadata: null` 抹掉。
- 开关、固定说明、总结通过 `PATCH /api/tasks/:id/persistent { enabled?, instructions?, summary? }` 修改：只合并这三个键，不回写服务端维护的轮次状态。
- 创建时通过 `POST /api/tasks { metadata: { persistent: { enabled: true } } }`。
- Project 显示开关：`project.metadata.showPersistentTasks === false` 时隐藏，缺省显示。

### 2. 消息标记

| 消息 | role | metadata |
|---|---|---|
| 结束本轮的总结请求 | `user` | `{ kind: "persistent_round_end", round }` |
| AI 的总结回复 | `sdk` | 原样（`reply_to` = 上面的消息 id） |
| 新一轮分隔 | `sdk` | `{ synthetic: true, kind: "persistent_round_start", round, backend_type, agent_host }` |

第 1 轮没有分隔消息：第一个分隔之前的消息都属于第 1 轮（所以普通任务转常驻时，原有历史就是第 1 轮）。

### 3. 结束本轮 `POST /api/tasks/:id/rounds/end`

1. 校验：`ai_task`、常驻已开启、未打包。已结束则幂等返回。
2. 若 task 正在运行：用 `appendUserMessageToTask` 发总结请求（role `user`，标记 `persistent_round_end`），把消息 id 写入 `roundEndMessageId`。没有活着的 fire 则跳过总结。
3. 写 `roundEndedAt`，返回 task。
4. fire **不在此时停止**：总结回复在 session-stream 模式下可能分多条、且晚于 "done" 状态到达，而 `killed` task 会丢弃后到的消息。空闲的 fire 不消耗 Token，下一轮开始时再停。

总结捕获：`commitSdkMessage` 写入新消息后，若 `metadata.reply_to === persistent.roundEndMessageId`，把内容写入 `persistent.summary`（最后一条覆盖前面的）。错误消息、`interrupted`/`synthetic` 消息和"未返回任何文本"占位都不算总结；总结截断到 8000 字符（prompt 走命令行 `--prefill`）。

所有对 `metadata.persistent` 的写（总结捕获、结束/开始轮次、设置）都用对原始 metadata 字符串的 compare-and-swap，并广播带 metadata 的 `task_status_update`，其他标签页 / 设备实时拿到轮次状态。

### 4. 开新一轮 `POST /api/tasks/:id/rounds`

请求：`{ content, backend_type?, agent_host?, worktree?: "inherit" | "new" | "none", expected_round? }`，`content` 必填。`expected_round` 与服务端轮次不一致时返回 409 `round_changed`（防止停留在旧状态的设备替换掉别处刚开的一轮）。

1. 校验：`ai_task`、常驻已开启、未打包。总结还在生成时也允许开新一轮（持久化的 `TaskRuntimeState` 不会可靠地回落 `replyInProgress`，不能用来判断），此时保留已捕获的部分，用户可在设置里修改。
2. 解析目标：backend 缺省沿用 task 的 `backendType`；daemon 缺省沿用上一轮的 daemon，其次项目 daemon。daemon 必须在线且支持该 backend；在上一轮所在 daemon 上开新一轮，要求它声明 `persistent_round_v1`（不论 task 当前状态）。
3. launch config：
   - `inherit`：同 daemon 时 `inheritTaskWorktreeLaunchConfig`，否则 `{ cwd, worktreeBranch }`；跨 daemon 只保留 `remoteWorktree`。
   - `new`：`buildTaskWorktreeLaunchConfig`，要求项目 git-backed 且 daemon 为项目 daemon。
   - `none`：`{ cwd: project.workspacePath, worktreeBranch }`。
4. 若 task 仍在运行：`stopTaskBeforeRelaunch` 停掉旧 fire，失败返回 409。
   - 竞态（E2E 发现）：旧 fire 先上报 `killed`、进程稍后才退出，此时 daemon 还持有该 task 的进程记录，会把紧接着的 `create_task` 当重复请求吞掉。
   - 解决：`create_task` 带 `replace_existing_fire: true`，daemon 先释放旧 fire 再启动：tmux 记录先 `has-session` 探测（死了直接清记录，还活着就 kill-session），子进程发 SIGTERM 并等待退出；旧 fire 的终态上报被抑制；启动前清掉同目录里旧 fire 未送达的 KILLED/COMPLETED；tmux reaper 看到正在启动的新轮次时不再上报旧死讯。仍释放不了才上报失败。daemon 通过 `persistent_round_v1` capability 声明支持。
   - `unknown` 状态也会先 stop（fire 可能只是连接断了）。
5. 事务内：先对 metadata 做 compare-and-swap（轮次已被别的请求推进则 409，避免重复开轮）；把该 task 仍 `pending`/`sent` 的 agent outbox 命令标记 failed（新 fire 重连用同一个 host 名，否则会收到上一轮排队的 `stop_task` 或总结请求）；写分隔消息 + 用户消息；更新 task：`status: "init"`、`backendType`、`agentHost`、`executionHost`、`sessionId/sessionFilePath: null`、`killedReason/killedAt: null`、`launchConfig`、`persistent.round + 1`、清空 `roundEndedAt/roundEndMessageId`。
6. 复用 `finalizeAiTaskCreation` 发 `create_task`，新增两个可选参数：`agentInitialContent`（发给 AI 的是拼好的 prompt，界面上展示和入库的是用户原文）和 `replaceExistingFire`。继承了 remote worktree 时，prompt 外面再套 `buildRemoteWorktreeBootstrap`。

发给 AI 的第一句：

```
[Persistent task — round N]
This is a new round of a recurring task. You start with a fresh session and no
prior conversation history.

Standing instructions:
<instructions>

Summary of previous rounds:
<summary>

---
<用户消息>
```

没有固定说明 / 总结时省略对应段落。

### 5. 前端

- **排序**：`orderTasksWithPinnedFirst` 改为 置顶 → 普通 → 常驻（常驻任务之间保持原顺序）。store、TaskList、手机端滑动共用。
- **过滤**：三条过滤链统一调用 `filterHiddenPersistentTasks(tasks, projects)`；合并的跨 daemon 项目只要有一个成员关闭就整组隐藏，与项目设置里开关的读法（所有成员都打开才算打开）一致。
- **Project 设置**：`ProjectDetailsDialog` 增加 "Show persistent tasks" 开关，走 `updateProjectGroupMetadata`（合并项目一起改）。
- **创建**：`CreateTaskDialog` 增加 "Persistent task" 复选框。
- **任务卡**：动作菜单增加 "Persistent"，打开 `PersistentTaskSettingsDialog`（开关、固定说明、上一轮总结；打开时拉取最新总结，只在打开时挂载）；常驻任务标题旁显示 `R{round}` 标记。
- **聊天**：
  - 常驻任务在输入框上方显示轮次栏：`Round N` + `End round` / `New round`。
  - `New round` 打开对话框：backend、daemon、worktree、第一条消息。
  - 本轮已结束或 task 已停止时，发送消息 = 用上一轮设置开新一轮。
  - 按分隔消息分组，最新一轮展开；旧轮次折叠成一行 `Round N · 日期 · backend · 总结首行`（跳过 markdown 标题），点击展开，展开状态按 task 存在 sessionStorage。起点在未加载页的那一轮不显示日期；折叠轮次里的问题不进问题导航；"加载更早消息"提示可点击，自动填满视口时不会穿过折叠轮次一直翻页。
  - 输入框发送和 New round 对话框走同一条开新一轮的路径（清运行状态、带 `expected_round`，409 时重新拉取 task）。
  - 总结请求发出后、AI 还没回复时，轮次栏显示 "Writing the round summary…"，输入框禁止发送，避免新一轮把总结截断；"New round" 按钮仍可用。
  - realtime 消息此前只读取 `payload.message.metadata`，服务端广播的是顶层 `metadata`，导致分隔消息、`reply_to` 要刷新后才生效；已改为回退读取顶层 `metadata`。

## Risks

- **总结捕获竞态**：`roundEndMessageId` 在总结请求消息创建之后写入。LLM 回复至少几百毫秒，实际窗口可以忽略；若漏捕获，用户可在设置里手写。
- **开新一轮的请求耗时**：需要先停掉旧 fire，`POST /rounds` 最长可能等约 67 秒（沿用 `stopTaskBeforeRelaunch` 的超时）。
- **旧 worktree 遗留**：`worktree: "new"` 后，旧轮次的 worktree 不再被 task 引用，打包 / 删除时不会被清理。第一期接受，文档说明。
- **fire 的 SDK 回写旧 sessionId**：fire 启动时 `bindTaskSession` 可能先回写本地记录的旧 session id，随后被新 session 覆盖；不会触发 resume。
- **按轮统计**：B 方案下没有独立的轮次记录，只能从分隔消息推导。
- **总结完成信号**：持久化的 `TaskRuntimeState.replyInProgress` 在总结回合结束后不会可靠回落，不能用作服务端守卫；前端用"还没有回复，或实时状态仍在回复这条请求"判断，并且只对常驻任务生效（关闭常驻会清掉未完成的轮次状态）。

## Rollout

- 纯增量：新 metadata 字段、两个新路由、前端开关。老任务没有 `persistent` 字段，行为完全不变。
- 无 schema 变更、无新环境变量。
- CLI：`@love-moon/conductor-cli` minor（changeset `daemon-persistent-task-rounds`）。在上一轮所在的 daemon 上开新一轮需要升级到带 `persistent_round_v1` 的 CLI；老 daemon 上返回 409 提示升级。

## Acceptance

- 普通任务可以开 / 关常驻；新建时可直接选常驻。
- 结束本轮后，AI 的总结写入 `persistent.summary`；开新一轮后，新 session 的 `sessionId` 与上一轮不同，第一句 prompt 包含固定说明和总结，不包含历史。
- 新一轮可换 backend / daemon / worktree；空闲时发消息会开新一轮。
- 常驻任务在列表置底；Project 关闭显示后，列表、计数、滑动切换都不含常驻任务。
- 聊天中旧轮次默认折叠，可展开。
- API 路由测试覆盖开 / 结束轮次与设置；前端测试覆盖排序过滤、轮次折叠、空闲发送、总结等待；daemon 测试覆盖 `replace_existing_fire`。

## Open Questions

- 定时自动开新一轮是否需要（第二期，接 ScheduledMessage）。
- 是否需要在 CLI（`conductor task round new/end`）暴露轮次操作。
