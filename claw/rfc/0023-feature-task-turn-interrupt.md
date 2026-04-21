# 0023 AI Task Turn Interrupt

## Status

Proposed

## Owner

TBD

## Date

2026-04-21

## Summary

为现有 `ai_task` 增加“中断当前 turn，但不结束 task / session”的能力。用户在 app 内发送消息后，如果发现误发、内容未写完、或当前回复方向错误，可以像原生 AI session 里按 `Esc` 一样，打断正在执行的当前轮回复，并立即恢复到“等待下一条消息”的状态。该能力只作用于当前 in-flight turn，不把 task 置为 `killing` / `killed`，也不关闭 `conductor-fire` 进程或底层 provider session。

## Context

- 目前 app 侧已经支持继续给 `running` 的 `ai_task` 发送后续 user message，入口在 [web/src/features/chat/components/ChatView.tsx](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/web/src/features/chat/components/ChatView.tsx:297)。
- 后续 user message 会通过 [web/src/lib/channel/task-ingress-service.ts](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/web/src/lib/channel/task-ingress-service.ts:243) 转成 `task_user_message`，下发给当前绑定的 fire host。
- 真正持有多轮 provider session、执行 `runTurn()` 的是 `conductor-fire`，核心逻辑在 [cli/bin/conductor-fire.js](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/cli/bin/conductor-fire.js:2474)。
- 当前系统已有 `stop_task`，但它的语义是停掉整个 task：`conductor-fire` 收到命令后会 `this.stopped = true` 并 `backendSession.close()`，见 [cli/bin/conductor-fire.js](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/cli/bin/conductor-fire.js:1965)。这会结束整个会话，不符合“只中断当前轮”的需求。
- provider 层实际上已有 turn-level interrupt 能力：
  - `codex-app-server-session.interruptCurrentTurn()`
  - `claude-agent-sdk-session.interruptCurrentTurn()`
  - `kimi-cli-session.interruptCurrentTurn()`
  - `opencode-sdk-session.interruptCurrentTurn()`
- 但 `@love-moon/ai-sdk` 的 `RemoteAiSession` 还没有暴露该方法，而且 worker 当前把所有请求串到同一条 `workQueue`，见 [modules/ai-sdk/src/worker.js](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/modules/ai-sdk/src/worker.js:132)。如果直接把 `interruptCurrentTurn()` 也当普通 request 发送，中断请求会排在 `runTurn()` 之后，无法真正即时打断。
- 前端 runtime store 已经有 `replyInProgress / replyTo / statusLine` 等字段，见 [web/src/features/realtime/store.ts](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/web/src/features/realtime/store.ts:194) 与 [web/src/shared/types/index.ts](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/web/src/shared/types/index.ts:154)，足以驱动“中断当前回复”的 UI。

## Goals

- 为 `running` 的 `ai_task` 提供“中断当前 turn”的产品能力。
- 中断后保留 task、fire 进程和 provider session，用户可以继续发送下一条消息。
- 中断只作用于当前 in-flight user message，对后续 turn 不产生误伤。
- UI 提供显式 stop 按钮，并支持输入框 `Esc` 快捷键。
- 保留已经流出的 partial assistant 输出，不做消息回滚。
- 对 `codex / claude / kimi / opencode` 保持统一语义。

## Non-Goals

- 不复用 `stop_task` 语义。
- 不把 task 写成 `killing / killed / completed`。
- 不停止 `conductor-fire` 进程。
- 不关闭或重建 provider session。
- 不为 `pty_task` 提供同名能力。
- v1 不处理“误发 user message 后把这条 user message 从历史中撤回”的需求。
- v1 不把 interrupt 做成 durable delayed command；后续若要做，也必须带严格作用域。

## Problem Statement

用户当前误触 `Enter` 发送后，系统会立即开始执行该轮消息。此时：

- 输入框仍可继续编辑 draft，但当前错误 turn 不会自行停止。
- 若使用现有 `stop_task`，会把整个 task 干掉，用户必须 restart 或新建任务，成本过高。
- 从用户心智上，正确语义应是“像原生 session 里的 `Esc` 一样，打断当前回复，然后继续在同一个会话里聊天”。

因此需要新增一个比 `stop_task` 更细粒度的控制平面：`interrupt_turn`。

## Options Considered

### Option A: 复用 `stop_task`

- Pros
  - 现有 server / sdk / fire / daemon 路径已存在
  - 不需要新增新的 command type
- Cons
  - 语义错误：`stop_task` 会结束整个 task
  - 中断后无法立刻继续在同一 session 聊天
  - 会把 task 状态推进到 terminal state

### Option B: 发送一条新的 user message 让模型“忽略上一条”

- Pros
  - 产品面最简单
  - 不需要改底层执行面
- Cons
  - 无法阻止当前 turn 继续运行
  - 会增加无意义 token 消耗
  - 对已经跑偏或长时执行的 turn 无法及时收敛

### Option C: 新增 `interrupt_turn` 控制命令

- Pros
  - 与用户心智一致
  - 不结束 task，能保留 session
  - 可以精准作用于当前 in-flight turn
  - 能复用 provider 已有的 `interruptCurrentTurn()`
- Cons
  - 需要跨 `web / conductor-sdk / conductor-fire / ai-sdk` 多层改造
  - worker 需要引入独立 control lane

## Proposed Design

### 1. 产品语义

- 该能力仅适用于 `taskType === "ai_task"` 且 task 当前为 `running`。
- 只有当 runtime 显示 `reply_in_progress = true` 时，前端才展示“中断”入口。
- 该命令只打断“当前这一轮”：
  - 若当前 turn 正在执行，则立即请求 provider interrupt。
  - 若当前 turn 已自然结束，则该 interrupt 视为过期，不再影响后续消息。
- 中断完成后：
  - task 状态保持 `running`
  - runtime 状态变为 `reply_in_progress = false`
  - 输入框立即恢复可继续发送下一条消息
- 若当前 turn 已输出部分 assistant 文本：
  - 保留已落库的 partial `sdk_message`
  - 不回滚、不标错
  - 用户可以继续追发下一条消息

### 2. 前端交互

#### 2.1 Chat UI

在 [web/src/features/chat/components/ChatView.tsx](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/web/src/features/chat/components/ChatView.tsx:99)：

- 从 runtime 读取：
  - `replyInProgress`
  - `replyTo`
  - `statusLine / statusDoneLine`
- 在 composer 上方现有 runtime status 区域旁边增加一个 stop 按钮：
  - 文案建议：`Interrupt`
  - 仅当 `replyInProgress === true` 时展示或启用
- 点击后调用新接口 `POST /api/tasks/[taskId]/interrupt`

#### 2.2 Esc 快捷键

在 [web/src/features/chat/components/MessageInput.tsx](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/web/src/features/chat/components/MessageInput.tsx:262)：

- 新增 `onInterrupt?: () => void` prop
- 当满足以下条件时，`Esc` 触发 interrupt：
  - 当前 task runtime `replyInProgress === true`
  - 输入框内容为空或全空白
  - 非 IME composing
- 当输入框内已有内容时，不抢占 `Esc`，避免与本地编辑习惯冲突

#### 2.3 反馈文案

- interrupt 请求成功后，不弹成功 toast，只更新 runtime 状态即可
- interrupt 请求失败时，显示 inline error：
  - `Failed to interrupt the current response. Please try again.`

### 3. API 设计

新增接口：

`POST /api/tasks/[taskId]/interrupt`

请求体：

```json
{
  "target_reply_to": "msg-user-123",
  "reason": "user_interrupt"
}
```

说明：

- `target_reply_to` 必填，必须等于当前前端 runtime 里正在执行的 user message id
- `reason` 可选，默认 `user_interrupt`

返回：

```json
{
  "ok": true,
  "task_id": "task-1",
  "target_reply_to": "msg-user-123",
  "request_id": "intr-req-1"
}
```

错误：

- `404`: task 不存在或不属于当前用户
- `409`: task 不是 `ai_task`、task 不在 `running`、或当前没有 active fire host
- `400`: `target_reply_to` 缺失

### 4. Server 侧行为

新增 route：`web/src/app/api/tasks/[taskId]/interrupt/route.ts`

处理逻辑：

1. 读取 task，校验归属。
2. 校验：
   - `taskType === "ai_task"`
   - `normalizeTaskStatus(task.status) === "running"`
   - 能解析出当前 fire host
3. 解析 `target_reply_to`。
4. 生成 `request_id`，直接通过 websocket 向 fire host 发送 `interrupt_turn`。
5. 不改 task row，不写 `agent_outbox`，也不更新 task status。

推荐 payload：

```json
{
  "type": "interrupt_turn",
  "payload": {
    "task_id": "task-1",
    "project_id": "proj-1",
    "request_id": "intr-req-1",
    "target_reply_to": "msg-user-123",
    "reason": "user_interrupt",
    "issued_at": "2026-04-21T10:00:00.000Z"
  }
}
```

v1 推荐不走 durable outbox，理由：

- interrupt 的价值是“即时性”，不是“最终一定投递”
- 若把它做成 durable command，延迟投递后可能击中下一轮 turn，语义风险大于收益
- 即使未来要做 durable interrupt，也必须至少带：
  - `target_reply_to`
  - `issued_at`
  - `expires_at` 或最大生存时间

### 5. Realtime / SDK 命令面

#### 5.1 Conductor SDK

在 [modules/conductor-sdk/src/client.ts](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/modules/conductor-sdk/src/client.ts:60) 里新增与 `onStopTask` 对称的 callback：

- `onInterruptTurn?: (event: InterruptTurnEvent) => Promise<void> | void`

新增 event type：

- downstream command `interrupt_turn`

新增解析与分发逻辑：

- `extractDownstreamCommandContext()` 支持 `interrupt_turn`
- 为 `interrupt_turn` 新增 ACK 路径，建议继续沿用 `agent_command_ack`
- 不复用 `task_stop_ack`

推荐新增类型：

```ts
export interface InterruptTurnEvent {
  taskId: string;
  requestId?: string;
  targetReplyTo?: string;
  reason?: string;
}
```

#### 5.2 ACK 语义

`interrupt_turn` 的 ACK 只代表“fire 已接受命令并尝试处理”，不代表 provider 一定已经停止。

ACK 建议沿用：

```json
{
  "type": "agent_command_ack",
  "payload": {
    "request_id": "intr-req-1",
    "task_id": "task-1",
    "event_type": "interrupt_turn",
    "accepted": true
  }
}
```

### 6. conductor-fire 侧行为

#### 6.1 与 stop_task 分离

当前 fire 只注册 `onStopTask`，见 [cli/bin/conductor-fire.js](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/cli/bin/conductor-fire.js:740)。

需要新增：

- `handleInterruptTurnCommand`
- `runner.requestInterruptFromRemote`

`requestInterruptFromRemote()` 的语义：

- 不设置 `this.stopped`
- 不设置 `remoteStopInfo`
- 不调用 `backendSession.close()`
- 仅尝试打断当前 turn

#### 6.2 Runner 内部状态

在 `BridgeRunner` 内新增：

- `currentReplyTo: string | null`
- `remoteInterruptInfo: { requestId?: string | null; targetReplyTo?: string | null; reason?: string | null } | null`
- 或等价的“本轮被远端中断”标记

在 [cli/bin/conductor-fire.js](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/cli/bin/conductor-fire.js:2474) 的 `respondToMessage()` 中：

- turn start 时记录 `currentReplyTo = replyTo`
- turn end 后清空

#### 6.3 处理 interrupt 命令

`requestInterruptFromRemote(event)` 的推荐逻辑：

1. 校验 `taskId`
2. 若 `targetReplyTo` 存在且不等于 `currentReplyTo`：
   - 直接忽略
   - 返回 `accepted = false` 或 `accepted = true but noop`，二者任选其一；v1 推荐 `accepted = false`
3. 若当前无 `runningTurn`：
   - 直接忽略
4. 若当前 turn 匹配：
   - 记录本轮 interrupt 信息
   - 调用 `backendSession.interruptCurrentTurn()`
   - 主动上报 runtime status：

```json
{
  "phase": "interrupt_requested",
  "reply_in_progress": true,
  "status_line": "interrupting current response"
}
```

5. 当 provider 真实收束后，再上报：

```json
{
  "phase": "interrupted",
  "reply_in_progress": false,
  "status_done_line": "response interrupted"
}
```

#### 6.4 turn 收束语义

`respondToMessage()` catch 分支当前只把 `stop_task` 视为正常中断，见 [cli/bin/conductor-fire.js](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/cli/bin/conductor-fire.js:2602)。

需要扩展为：

- 若当前错误是由 `remoteInterruptInfo` 导致：
  - 不调用 `reportError()`
  - 不把 task 置错
  - 不退出主循环
  - 仍然把 `replyTo` 标记为已处理，避免 reconnect/backfill 时重放同一条误发消息
  - 保留已发送的 partial assistant output

推荐日志文案：

- `turn interrupted by remote interrupt_turn`

### 7. AI SDK 改造

#### 7.1 暴露 interrupt API

在 [modules/ai-sdk/src/client.js](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/modules/ai-sdk/src/client.js:200)：

- `RemoteAiSession` 新增 `interruptCurrentTurn()`
- `LocalAiSessionProxy` 新增 `interruptCurrentTurn()`

`LocalAiSessionProxy` 可直接调用底层 session 的同名方法。

#### 7.2 Worker control lane

这是本 RFC 的关键实现点。

当前 [modules/ai-sdk/src/worker.js](/Users/duino/ws/conductor/.conductor/worktrees/26cf1292-19c4-497a-9578-6929af4aa8f6/modules/ai-sdk/src/worker.js:132) 使用单一 `workQueue` 串行执行所有 stdin 消息。若 `interruptCurrentTurn()` 继续沿用同一路径，会排在 `runTurn()` 后面，无法即时打断。

推荐改造：

- 引入 `message.type === "control"` 通道
- `control` 消息不进入 `workQueue`
- 仅允许少数幂等控制方法走该通道：
  - `interruptCurrentTurn`

示例：

```json
{
  "type": "control",
  "id": 42,
  "method": "interruptCurrentTurn",
  "args": []
}
```

worker 收到后立刻执行：

- `await session.interruptCurrentTurn()`
- 直接回 `response`

`RemoteAiSession.interruptCurrentTurn()` 则走该 control 通道，而不是普通 `callWorker()`

#### 7.3 provider 收束语义

provider 层已有 interrupt 能力，但中断后的错误 reason 目前不完全统一：

- `kimi` 已显式产出 `turn_cancelled`
- `codex / claude / opencode` 更多是 best effort interrupt，最终错误文案取决于 transport / provider

v1 不强制统一 provider error shape；由 fire 使用“本轮存在远端 interrupt 记录”来判定这次异常应被视为正常中断，而不是业务错误。

后续可考虑在 ai-sdk 统一约定：

- `reason: "turn_interrupted"`

### 8. Runtime 状态与前端可见性

runtime status 建议新增或约定以下 phase：

- `start_turn`
- `interrupt_requested`
- `interrupted`

前端行为：

- `replyInProgress === true` 时展示中断按钮
- 收到 `phase = interrupted` 且 `replyInProgress = false` 后：
  - 隐藏按钮
  - 保持 task 为 `running`
  - 输入框继续可发送

v1 不要求在 task row 中持久化“上一轮被中断”，该信息仅作为 transient runtime state。

### 9. 数据与兼容性

- 不需要 DB migration
- 不需要改 task status enum
- 不需要改 message schema
- 新增 command type：
  - `interrupt_turn`
- 新增 API：
  - `POST /api/tasks/[taskId]/interrupt`

## Sequence

### 1. User clicks Interrupt

1. `ChatView` 读取 runtime，拿到 `replyTo`
2. 前端调用 `POST /api/tasks/[taskId]/interrupt`
3. server 校验 task 仍在 `running`，并解析 fire host
4. server 直接向 fire host 下发 `interrupt_turn`
5. fire ACK `agent_command_ack(interrupt_turn, accepted=true)`
6. fire 调用 `backendSession.interruptCurrentTurn()`
7. provider 停止当前 turn
8. fire 上报 `task_runtime_status(phase=interrupted, reply_in_progress=false)`
9. 用户继续输入下一条消息

### 2. Interrupt arrives too late

1. 当前 turn 已经自然结束，`currentReplyTo` 已变化或为空
2. fire 收到旧的 `interrupt_turn`
3. fire 发现 `target_reply_to` 不匹配
4. fire 返回 `accepted=false`
5. 不影响下一轮 turn

## Acceptance Criteria

- 用户可以在 app 内对正在回复的 `ai_task` 点击 `Interrupt`，当前回复会被打断，task 仍保持 `running`。
- 当输入框为空且当前有 in-flight reply 时，按 `Esc` 触发同样的 interrupt。
- interrupt 后用户无需 restart task，即可发送下一条消息。
- 已经流出的 partial assistant output 会保留，不回滚。
- `stop_task` 语义保持不变，仍用于终止整个 task。
- `interrupt_turn` 不会把 task 状态写成 `killing / killed / completed`。
- 若 interrupt 延迟到达，不能误伤下一轮 turn。
- worker-backed session 的 interrupt 是即时生效的，不会被 `runTurn()` 串行阻塞。

## Testing Plan

### Web

- `POST /api/tasks/[taskId]/interrupt`
  - running ai_task 可成功发送 direct command
  - 非 ai_task 返回 409
  - 非 running task 返回 409
  - 缺失 `target_reply_to` 返回 400
  - fire host 离线返回 409

### Frontend

- `ChatView`
  - `replyInProgress = true` 时展示 interrupt 按钮
  - 点击按钮调用 interrupt API
- `MessageInput`
  - 空输入框 + replyInProgress 时，`Esc` 触发 interrupt
  - 非空输入框时，`Esc` 不触发 interrupt

### conductor-fire

- 当前 turn 正在执行时，`interrupt_turn` 会调用 `backendSession.interruptCurrentTurn()`
- interrupted turn 不会调用 `reportError()`
- interrupted turn 会把 `replyTo` 标记为已处理
- `target_reply_to` 不匹配时，不会影响当前 turn

### ai-sdk

- `RemoteAiSession.interruptCurrentTurn()` 可在 worker-backed session 上使用
- worker control message 不经过 `workQueue`
- 中断 request 能在 `runTurn()` 未完成时立即执行

### Manual

- 本地创建一个 `ai_task`
- 发送一条长回复 prompt
- 在 reply streaming 中点击 `Interrupt`
- 确认：
  - reply 停止
  - task 仍是 `running`
  - 已流出的文本仍保留
  - 继续发送下一条消息可正常工作

## Risks

- 不同 provider 的 interrupt 错误形态不一致，v1 需要 fire 自己做“这是正常中断还是异常失败”的判别。
- 若 runtime `replyTo` 与 fire 当前 in-flight reply 状态短暂不同步，interrupt 可能被安全地拒绝，用户需要再次点击。
- session file stream 模式下，partial output 天然会先落库；这符合预期，但会让“误发消息”仍留下部分执行痕迹。
- 若未来强行把 interrupt 做成 durable command，而没有 `target_reply_to + TTL` 约束，会有误伤下一轮 turn 的风险。

## Rollout

### Phase 1

- web interrupt API
- frontend 按钮
- conductor-sdk `interrupt_turn`
- conductor-fire 软中断语义
- ai-sdk control lane

### Phase 2

- `Esc` 快捷键
- provider error reason 统一为 `turn_interrupted`
- 更细的 UI 文案与 telemetry

### Phase 3

- 评估是否需要 scoped durable interrupt

## Open Questions

- `interrupt_turn` 的 ACK 在“无 active turn / replyTo 不匹配”时，应该返回 `accepted=false`，还是 `accepted=true but noop`？v1 推荐 `accepted=false`，更利于诊断。
- 是否要在 UI 中显示“Interrupted”短暂提示，还是仅靠 runtime status 收束？v1 推荐只用 runtime status。
- 被中断的 user message 是否需要在消息元数据里追加 `interrupted=true` 标记？v1 推荐不持久化，先观察真实需求。
