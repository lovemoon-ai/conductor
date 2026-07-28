# ui — 新建任务首条消息 409 竞态（Send 就绪判定不一致）

## Symptom（症状）
在网页版新建 AI 任务后，任务详情页的 Message 输入框和 Send 按钮一可用就立刻发首条消息，
`POST /api/tasks/<id>/messages` 稳定返回 **409**，页面提示
“Failed to send the message. Please try again in a moment.”，且用户输入被清空丢失。
等几秒（fire 会话连上）后重发即 200 成功。QA Round 5 在两个任务上稳定复现
（`ba6aba60-…`、`3ded2223-…`）。

## Root cause（根因）
前后端对“任务可以收消息了”用了**两个不一致的就绪信号**：

- 前端：`ChatView` 以 `task.status === 'running'` 解锁 Send（`isTaskRunning`）。
- 后端：`task-ingress-service.appendUserMessageToTask` 对 `role=user` 的消息要求
  `execution_host` 已绑定到 `conductor-fire-*`（`resolveTaskUserMessageFireHost`），
  否则抛 `TASK_MISSING_ACTIVE_FIRE_OWNER` → 409。

而 `status` 变 `running` 发生在 **daemon 认领任务**时（`execution_host` 还是 daemon 主机名，
如 `debug`），早于 **fire 子进程连接并绑定** `execution_host=conductor-fire-*`。
这段“已 running 但 fire 未绑定”的窗口里发首条消息就必然 409。
诊断证据印证：409 当时 `status=running`、`execution_host=debug`；变为 `conductor-fire-*` 后重试即 200。

雪上加霜：`MessageInput.submitContent` 在调用 `onSend` 后**无条件清空输入框**，
`store.sendMessage` 失败又回滚乐观消息 → 用户输入彻底丢失，需重打。

> 注：该 fire-owner 校验自 2026-04（commit `eee2f6a` 加入任务 turn 中断）就存在，
> 非本次发布引入；属长期存在的启动竞态。

## 为什么不用“前端按 execution_host 置灰 Send”修（重要，避坑）
排查发现客户端**收不到 `execution_host` 变化**：`task_status_update` 广播只带 `status`
（`task-event-projector.ts`），客户端 `realtime/store.ts` 处理该事件时也只 merge `status`，
其余在场事件均不更新 `executionHost`。若改成前端按 `executionHost` 是否为 fire host 置灰 Send，
按钮会在任务真正就绪后**一直卡在灰色**直到手动刷新——比原 bug 更糟。故放弃 UI 置灰方案。

## Fix（修复）
客户端“**特定 409 自动重试 + 幂等键 + 不丢草稿**”，自包含、不改通信协议：

1. 后端给该 409 的响应体加稳定机器码 `code: "task_missing_active_fire_owner"`
   （`task-ingress-service.ts`），客户端据此精确识别（不做脆弱的文案匹配）。
2. `store.sendMessage`：命中该 409 时**保留乐观气泡**，在 ~10s 窗口内小退避（0.5→1.5s）
   自动重试，直到 fire 绑定成功返回 200；带 `client_request_id` 幂等键，
   保证“重试撞上迟到的成功”也不会重复落库（后端已支持 `clientRequestId` 去重）。
   其它 409（归档/pty 等终态）**不重试**，立即失败。
3. 超时兜底：真到不了就绪则移除乐观气泡、抛错；`ChatView` 在 catch 里
   通过 `MessageInputHandle.restoreDraft(content)` 把文本放回输入框（仅当用户未开始新草稿），
   用户永不丢字。

改动文件：
- `web/src/lib/channel/task-ingress-service.ts`（加 `code`）
- `web/src/shared/types/index.ts`（`ApiError.code`、`SendMessageInput.clientRequestId`）
- `web/src/features/chat/store.ts`（重试 + 幂等）
- `web/src/features/chat/components/MessageInput.tsx`（`restoreDraft`）
- `web/src/features/chat/components/ChatView.tsx`（失败恢复草稿）

## Tests
- `store.test.ts`：三条新用例——命中 fire-owner 409 自动重试直到成功且幂等键稳定、
  超时放弃并移除乐观气泡、非 fire-owner 409 不重试。
- `messages/route.test.ts` & `task-ingress-service.test.ts`：断言 409 响应体/details 含
  `code: "task_missing_active_fire_owner"`。
- `cd web && pnpm test`（相关文件 26 passed）。

## How to avoid next time（如何避免）
- **前后端“就绪/可操作”判定必须是同一信号。** 用 `status==='running'` 解锁一个动作前，
  确认后端接受该动作的条件是否也仅为 `running`；本例后端还要 fire owner 绑定。
- **可能瞬时失败的用户输入动作，失败要保留输入**，不能在 `onSend` 后立即无条件清空。
- **给可被客户端分支处理的错误一个稳定 `code`**，不要让客户端靠文案字符串判断。
- 选“前端 gating”方案前，先确认**门禁所依赖的状态字段确实会实时推给客户端**，
  否则会造成“按钮卡死”这类更严重的回归。
