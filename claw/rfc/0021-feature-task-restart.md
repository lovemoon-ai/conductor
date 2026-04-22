# 0021 AI Task Restart with Backend Switch

## Status

Superseded (2026-04-22)

> **Superseded by share-link handoff.** The cross-backend path described
> here (using `@love-moon/ai-bridge` to translate the source backend's
> JSONL session into the target backend's native session, then
> `--resume <synthesized-id>`) was retired in commit `34ae838` because
> it was fragile (schema drift, broken parentUuid chains, silent
> failures, sticky to the source daemon's local disk).
>
> The current implementation mints a short-lived internal share of the
> source task (`SharedTask.kind = "resume_handoff"`, 24h TTL, rotating
> token, 7d hard cap) and passes its `/share/<token>/plain` URL to the
> successor CLI as a prompt. The target AI fetches the transcript itself.
>
> **Backend-agnostic as of commit `815c028` (2026-04-22).** The old design limited
> cross-backend restart to a hardcoded set (`codex / claude / kimi`)
> because ai-bridge only knew how to translate those JSONL formats. The
> share-link handoff has no such constraint: any pair of backends that
> the target daemon advertises as `supportedBackends` can be paired,
> including `opencode` and any custom provider registered via
> `AISDK_PROVIDER_PATH`. The only runtime requirement on the target
> backend is that its CLI can perform an HTTP fetch — a capability every
> mainstream coding assistant (Claude Code, Codex, Kimi CLI, OpenCode)
> ships by default. If the fetch fails at runtime, the handoff prompt
> explicitly tells the target AI to ask the user for a recap, so the
> failure mode is visible and graceful.
>
> The `resume_inplace` (same-backend) flow described below is unchanged
> and still authoritative. Only the cross-backend translation step is
> obsolete.

## Owner

TBD

## Date

2026-03-24

## Summary

为现有 `ai_task` 增加 restart / backend switch 能力，但采用混合语义，而不是统一 inplace。若目标 backend 与当前 backend 相同，则对原 task 做原地 restart，直接基于当前 `sessionId` 恢复；若目标 backend 不同，则在当前 daemon 主机上通过 `@love-moon/ai-bridge` 将源 session 转换为目标 backend 的 session，并创建一个与源 task 关联的新 task，在新 task 上继续运行。backend switch 路径本质上是“基于 source task 的 provider session 新建一个 successor task”，而不是对 source task 原地继续；source task 的生命周期与状态保持不变。第一阶段只支持同一 daemon 上的操作；跨 backend 转换仅支持 `codex / claude / kimi` 之间切换，不支持涉及 `opencode` 的转换。

## Context

- 目前 web 侧已经能创建 `ai_task`，并把 `backendType / sessionId / sessionFilePath` 存入 task 记录。
- `conductor-fire` 启动后会通过 `bindTaskSession()` 回写真实 session 绑定，因此 task 记录已经是“从 task 找回 backend session”的唯一服务端入口。
- 聊天 UI 已经提示 stopped task “Restart it before sending more messages.”，但实际上 `ai_task` 没有 restart 入口。
- `pty_task` 已经有“停掉旧进程并原地重启”的 PATCH 路径，但 `ai_task` 没有对应能力。
- 当前 server -> daemon 的 `create_task` 协议只包含 `backend_type / initial_content`，不包含 restart 所需的 `session_id` 和“切 backend”语义。
- 当前 `conductor fire --resume` 会先做 provider-specific 的本地 session 解析，再切换 cwd；这条路径目前不支持 `opencode`，也不适合 daemon 驱动的 task restart。
- `ai-bridge` 的本地源码位于 `/Users/duino/ws/ai-session/ai-bridge`。现状确认如下：
  - 支持的 adapter 为 `codex / claude / kimi / copilot`
  - 不支持 `opencode`
  - 当前主入口偏 CLI：默认会在 bridge 完成后直接 spawn 目标工具，不适合 Conductor 在 daemon 内做非交互式调用
- backend session 是本地状态，不在服务端。无论是“同 backend resume”还是“切 backend bridge”，都必须在拥有源 session 的本地 daemon 上执行，不能放到 web server。

## Goals

- 为已有 `ai_task` 提供可恢复的 restart 能力。
- 在 backend 不变时保留原 task id，做原地 restart。
- 在 backend 改变时创建一个 linked successor task，作为独立的新 task 继续。
- 相同 backend 时直接 resume 当前 session，不做 bridge。
- 不同 backend 时通过 `ai-bridge` 做 session 转换，并在新 task 上继续运行。
- 保持 provider/session 文件细节不泄漏到 web server。
- 复用现有 `bindTaskSession()` 作为 restart 成功后的 session 绑定入口。
- 不改变现有 plan limit 口径；backend switch 创建的新 task 按普通 task 计数，不做配额豁免。

## Non-Goals

- 不为 `pty_task` 设计新的 restart 语义；PTY 继续沿用现有路径。
- 不支持“从 Conductor 消息历史逆推出一个全新 provider session”。
- 不支持跨 daemon / 跨主机 restart。
- 不支持从 app 侧 restart 手工启动的 `conductor-fire-*` task。
- 第一阶段不支持任何涉及 `opencode` 的跨 backend bridge。
- 不做“clone 成新 task”的旁路流程。
- 不在 backend switch 时把旧 task 的历史消息复制到新 task，也不把 source context 重新注入 successor chat box。

## Options Considered

### Option A: 所有 restart 都创建新 task

- Pros
  - server 和 daemon 逻辑最简单
  - execution attempt 的边界最清楚
- Cons
  - 破坏“Restart it before sending more messages.”这类现有用户心智
  - 同 backend resume 也会被拆成多个 task，过于重
  - 会重新占用 task 配额
  - 与 PTY 的“原地重启”模型不一致

### Option B: 所有 restart 都原地 inplace

- Pros
  - 用户心智最统一
  - task 列表不会增加新项
- Cons
  - backend switch 不是原生 resume，而是 session migration，语义并不真的“原地”
  - 同一 task 会混入多个 backend 的 run，诊断和审计会变差
  - bridge 失败回滚更复杂，容易污染原绑定

### Option C: backend 不变时 inplace，backend 改变时创建 linked task

- Pros
  - 同 backend 路径保留最顺的用户体验
  - backend switch 仍保留清晰的 execution 边界
  - 原 task 继续作为 source-of-truth，bridge 失败不会污染它
  - 最符合“resume”和“session migration”是两种不同语义的事实
- Cons
  - 当前 daemon 必须在线
  - backend switch 后，Conductor 历史会分散在两个 linked task 中
  - 前端需要处理“有时留在原 task，有时跳到新 task”的差异

## Proposed Design

### 1. 产品语义

- `restart` 只适用于 `ai_task`。
- 默认目标 backend 为当前 task 的 `backendType`。
- v1 restart / switch backend 只对 stopped (`completed` / `killed`) 的 `ai_task` 暴露；若 source task 仍在运行则直接拒绝。
- 若目标 backend 与当前 backend 相同：
  - 对原 task 做 inplace restart
  - task id 不变
- 若目标 backend 与当前 backend 不同：
  - 创建一个 linked successor task
  - successor task 与 source task 生命周期独立
  - source task 状态保持不变
  - 用户跳转到 successor task
- 若用户切换 backend：
  - 只允许选择 `source task.agentHost` 已宣告支持的 backend
  - 只允许 `codex / claude / kimi` 之间互转
- v1 要求源 task 必须已有持久化的 `sessionId` 和 `backendType`；若缺失则直接拒绝。

用户侧文案建议拆开：

- 同 backend：`Restart`
- 切 backend：`Switch Backend`

### 2. 支持范围

- 同 backend restart：
  - 支持 `codex / claude / kimi / opencode`
  - 走“直接 resume 现有 session”路径
- 跨 backend restart：
  - 仅支持 `codex <-> claude <-> kimi`
  - 使用 `ai-bridge`
  - 创建 linked new task
- 不支持：
  - `opencode -> codex|claude|kimi`
  - `codex|claude|kimi -> opencode`
  - 任何涉及 `copilot` 的 app 内 restart

backend 到 `ai-bridge` tool 的映射如下：

- `codex -> codex`
- `claude -> claude`
- `kimi -> kimi`

### 3. API 设计

新增接口：

`POST /api/tasks/[taskId]/restart`

请求体：

```json
{
  "backend_type": "claude"
}
```

说明：

- `backend_type` 可选；缺省时表示同 backend restart
- v1 不暴露 `agent_host`，因为 restart 只能在当前 daemon 上执行
- 返回体中的 `task` 为完整 task snapshot，结构与现有 `serializeTaskResponse()` 一致

返回：

- 返回统一结构：

```json
{
  "mode": "inplace_restart",
  "source_task_id": "task-1",
  "task": {
    "id": "task-1",
    "title": "Fix login bug",
    "status": "unknown",
    "backend_type": "codex",
    "session_id": "sess-old",
    "session_file_path": "/tmp/rollout-1.jsonl",
    "metadata": null
  }
}
```

或：

```json
{
  "mode": "backend_switch_new_task",
  "source_task_id": "task-1",
  "task": {
    "id": "task-2",
    "title": "Fix login bug [claude]",
    "status": "unknown",
    "backend_type": "claude",
    "session_id": null,
    "session_file_path": null,
    "metadata": {
      "continuedFromTaskId": "task-1",
      "restartSourceBackendType": "codex"
    }
  }
}
```

规则：

- 同 backend 时，`task.id === source_task_id`
- 切 backend 时，`task.id` 为新 task id，前端应跳转到新 task

### 4. Server 侧行为

`web` 新接口的处理逻辑：

1. 读取 task，校验归属和 `taskType === "ai_task"`。
2. 校验：
   - `backendType` 存在
   - `sessionId` 存在
   - 当前 task 状态是 stopped (`completed` / `killed`)
   - `source task.agentHost` 存在，且不是 `conductor-fire-*`
   - `source task.agentHost` 对应 daemon 在线
   - restart / switch backend 的 target daemon 固定等于 `source task.agentHost`
   - `bound host / executionHost` 仅作为运行期残留信息，不参与 restart 路由选择
   - `source task.agentHost` 支持目标 backend
   - 若发生 backend switch，则源/目标 pair 可被 `ai-bridge` 支持
3. 生成 `request_id` 和 `restart_task` payload。若是 backend switch，先预分配 `successorTaskId` 作为 `target_task_id`。
4. 在同一个 DB transaction 中同时完成：
   - 写入 `agent_outbox` 中的 `restart_task` row
   - 对应的 task mutation
5. transaction commit 成功后，再做 transaction 外的 best-effort immediate delivery；若本次没有立即投递成功，也由 durable outbox 负责后续重试。
6. 若 transaction 失败，直接返回错误，不改 task 状态，也不创建 successor task。

同 backend：

7. 更新原 task：
   - `status = "unknown"`
   - `executionHost = null`
   - `agentHost` 保持 `source task.agentHost`
   - `backendType/sessionId/sessionFilePath` 暂不覆盖，避免 restart 失败时丢失源绑定
8. 返回更新后的原 task 完整快照。

不同 backend：

7. 创建 successor task：
   - `projectId` 与源 task 相同
   - `title` 默认基于原 title 生成，并追加目标 backend 标识，例如 `Fix login bug [claude]`
   - `agentHost` 指向 `source task.agentHost`
   - `executionHost = null`
   - `backendType = target backend`
   - `sessionId/sessionFilePath = null`
   - `status = "unknown"`
   - `metadata.continuedFromTaskId = source task id`
   - `metadata.restartSourceBackendType = source backend`
8. 回写源 task metadata：
   - `metadata.successorTaskId = new task id`
   - `metadata.backendSwitchRequestId = request id`
   - source task 状态保持不变
9. 返回新 task 完整快照。

v1 推荐不做 schema 变更，source/successor 关系先放在 `metadata` 中。

`restart_task` payload 建议使用 mode-specific union。

同 backend:

```json
{
  "mode": "resume_inplace",
  "source_task_id": "task-1",
  "target_task_id": "task-1",
  "project_id": "proj-1",
  "title": "Fix login bug",
  "source_backend_type": "codex",
  "source_session_id": "sess-old",
  "target_backend_type": "codex",
  "request_id": "req-1"
}
```

不同 backend:

```json
{
  "mode": "bridge_to_new_task",
  "source_task_id": "task-1",
  "target_task_id": "task-2",
  "project_id": "proj-1",
  "title": "Fix login bug [claude]",
  "source_backend_type": "codex",
  "source_session_id": "sess-old",
  "source_session_file_path": "/tmp/rollout-1.jsonl",
  "target_backend_type": "claude",
  "request_id": "req-1"
}
```

### 5. Agent Command 协议

- 新增 command type：`restart_task`
- 继续沿用现有 `agent_command_ack`
- `command_event_type = "restart_task"`
- 使用 `request_id` 做幂等去重
- 不复用 `create_task`

原因：

- `create_task` 语义是“创建新 run + 可能新建 workspace”
- `restart_task` 语义是“基于旧 session 做 resume 或 migration，然后在指定 target task 上继续”
- 两者的失败语义和幂等边界不同，混在一起会让 daemon 状态机变脏

### 6. Daemon 侧行为

`cli/src/daemon.js` 增加 `handleRestartTask(payload)`：

1. 校验 payload 完整性。
2. 若 `source_task_id === target_task_id` 且当前 task 仍有活跃 child，拒绝重复 restart；正常场景下 source task 已是 stopped，若不是则视为重复或越权调用。
3. 解析 restart 模式：
   - `mode = resume_inplace`
     - 直接复用 `source_session_id`
     - `target_task_id = source_task_id`
   - `mode = bridge_to_new_task`
     - 调用 `ai-sdk` 暴露的 bridge helper
     - 产出新的 target session id
4. 解析 cwd：
   - 优先使用当前 project bound path
   - 若 bridge 返回了 `cwd`，则以 bridge 的 `cwd` 为准
   - 兜底用当前 task 的 session store 记录
5. spawn 新的 `conductor-fire`，并附带：
   - `--backend <target>`
   - `--resume <resolvedSessionId>`
   - `CONDUCTOR_TASK_ID=<target_task_id>`
   - `CONDUCTOR_RESUME_CWD=<resolved cwd>`
6. 按现有 create_task 路径上报：
   - `task_status_update(UNKNOWN)`
   - fire 启动后再进入 `RUNNING`

bridge 失败时：

- 若是 inplace 路径：
  - daemon 直接回传原 task `task_status_update(KILLED, summary="restart failed: ...")`
  - 不覆盖 server 上原有的 `sessionId/sessionFilePath`
- 若是 backend switch 路径：
  - daemon 回传新 task `task_status_update(KILLED, summary="backend switch failed: ...")`
  - 源 task 保持原有状态和原有绑定不变

### 7. Fire 侧改动

`cli/bin/conductor-fire.js` 增加 daemon 驱动的 resume cwd override：

- 优先读取 `CONDUCTOR_RESUME_CWD`
- 若存在：
  - 直接 `applyWorkingDirectory(CONDUCTOR_RESUME_CWD)`
  - 跳过现有 `resolveResumeContext()`
- 若不存在：
  - 保持当前 `conductor fire --resume` 行为不变

这样做的价值：

- daemon 驱动 restart 不再依赖 fire 内部的 provider-specific session 解析
- 同 backend 的 `opencode` restart 可以工作，因为 fire 不再要求本地 `resolveResumeContext(opencode)`
- daemon 统一决定“这次 run 应该在哪个 cwd 上 resume”

### 8. ai-sdk / ai-bridge 集成边界

不建议让 `cli/src/daemon.js` 直接 deep import `ai-bridge` 内部 adapter。

建议在 `modules/ai-sdk` 增加一层薄封装，例如：

```ts
type BridgeableBackend = "codex" | "claude" | "kimi";

type BridgeSessionParams = {
  sourceBackend: BridgeableBackend;
  sourceSessionId: string;
  sourceSessionFilePath?: string;
  targetBackend: BridgeableBackend;
  skipTools?: boolean;
};

type BridgeSessionResult = {
  sessionId: string;
  cwd: string;
  irPath?: string;
};

export async function bridgeSessionBetweenBackends(
  params: BridgeSessionParams,
): Promise<BridgeSessionResult>;
```

原因：

- provider/session 语义应该继续留在 `ai-sdk` 边界内
- daemon 只需要知道“是否 bridge 成功、得到哪个 sessionId、应该在哪个 cwd 上启动 fire”
- 未来若 `ai-bridge` API 变化，改动面更小

对 `ai-bridge` 的要求：

- 必须提供 programmatic API
- 必须支持非交互式 bridge
- 不应在 bridge 完成后自动 spawn 目标工具
- 应能返回机器可读结果：`sessionId / cwd / irPath`

### 9. Frontend

新增 stopped `ai_task` 的 restart / switch backend 入口：

- task detail 页
- task list item 的 stopped 状态操作区

交互规则：

- v1 只展示“当前 daemon 支持的 backend”
- “当前 daemon” 指 `source task.agentHost`
- 默认选中当前 backend
- 若当前 task 属于 `conductor-fire-*`，按钮禁用并提示“manual fire task 暂不支持 app 内 restart”
- 若当前 task 没有 `sessionId`，按钮禁用并提示“missing session binding”
- successor task 默认标题应体现 backend switch，例如 `<source title> [claude]`
- 提交后：
  - 调用 `POST /api/tasks/[taskId]/restart`
  - 若 `mode = inplace_restart`：
    - 更新原 task store
    - 清掉该 task 的 runtime store，等待新 run 上报
  - 若 `mode = backend_switch_new_task`：
    - 将新 task 插入 store
    - 跳转到新 task

linked task UI：

- source/successor 关系可在 header metadata 中呈现，但不是协议必需项
- v1 不复制旧消息，也不向 successor chat box 注入 source context；跨 backend 的连续性由 provider session bridge 保证，Conductor 只通过标题和 metadata 提示来源

### 10. 状态与绑定原则

same-backend inplace restart：

- server 在 restart 请求入队并落库时，不主动清空旧 `sessionId`
- 新 fire 成功启动后，仍然通过现有 `bindTaskSession()` 覆盖：
  - `backendType`
  - `sessionId`
  - `sessionFilePath`
- 因此“restart 成功后的真实绑定”仍只有 fire 是可信来源

backend switch：

- source task 保留原状态
- source task 保留原 `backendType/sessionId/sessionFilePath`
- successor task 初始不带 session 绑定
- bridge 完成并启动新 fire 后，再由新 fire 对 successor task 执行 `bindTaskSession()`
- 因此 source task 永远是 bridge 的审计源，successor task 是后续执行的承接点
- successor task 按普通新 task 参与 plan limit 统计，不做特殊豁免

### 11. 测试

至少补以下测试：

- Web API route test
  - `POST /api/tasks/[taskId]/restart` 成功派发 `restart_task` 并返回完整 task snapshot
  - 缺少 `sessionId` 时返回 409
  - backend 不被当前 daemon 支持时返回 409
  - `conductor-fire-*` task 返回 409
  - source task 不是 stopped 时返回 409
  - source task 缺少 `agentHost` 或 `agentHost` 离线时返回 409
  - restart target daemon 固定使用 `source task.agentHost`
  - backend switch 时返回新 task snapshot，且 source task 状态保持不变
- Daemon test
  - same-backend restart 不调用 bridge，直接 spawn fire with `--resume`
  - cross-backend switch 调用 bridge，并在 `target_task_id` 上启动 fire
  - bridge 失败时回传 killed summary
- Fire test
  - `CONDUCTOR_RESUME_CWD` 存在时跳过 `resolveResumeContext()`
  - same-backend `opencode` restart 可走 daemon 驱动路径
- Widget test
  - stopped ai task 展示 restart UI
  - backend 选项受当前 daemon 支持集约束
  - backend switch 后自动进入 successor task
  - successor task 标题体现 target backend

## Risks

- `ai-bridge` 当前没有 `opencode` adapter，且主入口偏交互式；若不先补稳定 API，Conductor 侧会被迫走脆弱集成。
- source session 完全依赖当前 daemon 本地状态；daemon 离线或 session 文件丢失时无法 restart。
- 原地 restart 会继续沿用 fire 现有“session started” synthetic sdk message 行为，聊天流里会出现多次启动提示。
- backend switch 会让 Conductor 消息历史分散到两个 linked task；若标题或 metadata 提示不足，用户会误以为历史丢了。
- 若 server 在 restart / switch 前后错误覆盖了旧 session 绑定，失败回滚会变复杂。

## Rollout

- Phase 1
  - 补 `ai-bridge` programmatic API
  - 补 `ai-sdk` bridge helper
  - 补 fire `CONDUCTOR_RESUME_CWD`
  - daemon 增加 `restart_task`
  - web 增加 restart API 与基础 UI
- Phase 2
  - 评估是否需要去重或折叠 synthetic “session started” 消息
  - 评估是否要把 source/successor 关系升级为显式 schema，而不是 metadata
- Phase 3
  - 若未来要支持跨 daemon restart，再单独做 session artifact 迁移 RFC

兼容性：

- 无 schema 变更是首选
- 若仅把 restart 元信息放进 `metadata`，则不需要 migration
- 现有 task/create/message 协议不变，只新增 `restart_task`

## Acceptance

- 用户可以对一个已停止的 daemon-backed `ai_task` 发起 restart。
- 同 backend restart 会直接 resume 原 session，且不创建新 task。
- 跨 backend switch 会在同一 daemon 上调用 `ai-bridge`，并创建一个 linked successor task。
- source task 保留原状态、原消息历史和原 session 绑定。
- successor task 承接 backend switch 之后的新消息历史，并按普通 task 计数。
- backend switch 不会把 source 历史消息重新注入 successor chat box。
- `codex / claude / kimi / opencode` 支持同 backend restart。
- `codex / claude / kimi` 支持同一 daemon 内的跨 backend switch。
- 涉及 `opencode` 的跨 backend bridge 会被明确拒绝。
- 至少有 1 个 API route test 和 1 个 widget/daemon/fire test 覆盖主路径。

## Open Questions

- fire 现有的 synthetic “session started” sdk message，在 restart 场景下是否要保留，还是只保留 runtime status？
- bridge 时是否保留 tool calls / tool results，还是某些 backend pair 需要默认 `skipTools`？
