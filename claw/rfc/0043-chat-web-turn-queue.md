# 0043 chat-web 跨任务 turn 队列

## Status

Implemented — 跨进程 turn 队列与真实 Kimi 双任务验收已通过。

## Date

2026-10-25

## Design

每个 provider/profile 使用一个本地浏览器 broker 进程。Conductor AI SDK 的
chat-web 会话通过本机 socket 连接该进程；每个任务创建独立标签页，保留
各自会话和上下文。broker 按 FIFO 执行完整 turn（发送至回复完成），空闲
会话不占执行权。不同 provider 使用独立 broker，可同时工作。

增加 QueuedChatSession 公开 SDK，AI SDK 优先使用它。保留直接操作 Page 的
ChatSession，供独占登录、诊断、自定义 provider 及已有调用方使用。
同一个 QueuedChatSession 的调用也串行提交，避免一个任务提前塞满跨任务
队列。排队时间不计入生成回复的 timeoutMs，等待期间回报队列位置。

broker 使用当前用户可访问的本地 socket，不开放网络接口；原子启动锁确保
多个 worker 同时启动时只产生一个 owner。客户端断开会取消待执行请求并
关闭自己的标签页；活动 turn 失败后先停止/关闭对应页，再让队列继续。
关闭一个任务不会关闭其他任务的页。最后一个客户端离开后 broker 自动
释放浏览器与 profile。broker 崩溃会明确使请求失败，不自动重发聊天消息。

## Validation

覆盖跨会话 FIFO、独立上下文、A1/B1/A2 顺序、错误/取消不阻塞后续任务、
客户端退出、启动竞争、断线和空闲回收。使用真实 Kimi 账号验证两个独立
AI SDK worker 交替对话，各自记住不同测试信息。


## API 与生命周期

- AI SDK 自动优先使用 QueuedChatSession；旧版 chat-web 缺少此导出时保留
  ChatSession 回退。现有 `web-kimi: chat-web --model kimi` 配置无需改变。
- 直接使用 SDK 可调用 `QueuedChatSession.open("kimi")` 创建各自会话，随后
  调用 send/newChat/close。该接口提供 turns、conversationId、isLoggedIn、
  diagnose、snapshot；直接 Page 访问仍使用独占 ChatSession。
- 每个 profile 有一个 broker；首个调用决定其浏览器启动参数。后续连接复用
  同一浏览器。不同 CHAT_WEB_HOME/profile/provider 各有自己的队列。
- onQueue(position) 中 0 表示开始执行，正数表示前面等待/执行的操作数。
  AI SDK 将其映射为 queued / turn_started working_status。timeoutMs 在取得
  turn 执行权后才计时，不包含队列等待。
- close 和 AI SDK interruptCurrentTurn 可取消自己的排队/活动操作；其他任务继续。活动操作失败时会取消等待、尝试 provider 的网站停止接口，并
  关闭该任务标签页，之后该 session 明确报关闭错误，调用方需创建新会话。
  broker/浏览器断线也明确报错；不自动重发可能已提交的网站消息。
- 最后一个客户端离开后 5 秒自动关闭共享浏览器。任务长时间空闲可以保留
  自己的页，但不会占据 turn 执行权。关闭一个任务只关闭它自己的标签页。
- broker 使用本地用户私有 socket/命名管道；启动 owner 锁与 Chromium
  profile 锁配合，清理崩溃 owner 后可以重新启动。未增加依赖或 Web API。

## 真实 Kimi 验收

在 macmini 已登录 profile 上创建两个独立 AI SDK worker，配置均为
`createAiSession("chat-web", { model: "kimi" })`。两个 worker 同时启动成功，
执行顺序为 A1 → B1 → A2 → B2：

1. A1 记住 RED 测试口令和数字 47，B1 记住 BLUE 测试口令和数字 83。
2. A2 正确复述 RED/47；B2 正确复述 BLUE/83，没有互相泄漏上下文。
3. A 的两轮 conversationId 一致，B 的两轮一致，A 与 B 的 ID 不同。
4. 收到 B1 等待 A1、A2 等待 B1 的 queued 状态，以及实际开始执行后的状态。
5. A2 后先关闭 A，B2 仍成功，证明任务关闭不会关闭共享浏览器。

浏览器进程测试另覆盖同时启动的两个独立进程、任务 SIGKILL、broker SIGKILL
后的孤儿浏览器回收，以及最后客户端退出后的 owner/profile 释放。失败、
超时、排队取消、忽略 AbortSignal 的适配器与浏览器崩溃由受控测试覆盖。


## 验证命令

- `npm run build --workspace @love-moon/chat-web`
- `npm run build --workspace @love-moon/ai-sdk`
- `npm run test --workspace @love-moon/chat-web`
- `node --import tsx --test --test-concurrency=4 --test-reporter=dot modules/ai-sdk/test/*.test.js`
- `node --test --test-reporter=dot cli/test/conductor-config.test.js cli/test/conductor-fire-args.test.js cli/test/fire.test.js cli/test/ai-sdk-boundary.test.js`

未新增 Web API route，因此没有新增路由映射；跨进程 socket 协议、SDK 与 CLI
既有入口通过各自测试覆盖。真实网站验证限定为 Kimi；其他 provider 的
排队、生命周期和版本回退由受控样本/既有回归测试覆盖。


最后一轮检查结果：chat-web 22 个测试文件、164 项测试通过；AI SDK 全部 JS
回归与新增排队/中断测试通过；相关 CLI 配置、参数、fire、SDK 边界测试通过。
chat-web 与 ai-sdk 构建通过。首版直接 ChatSession 的独占行为保持兼容，
Conductor AI SDK 默认改用跨进程排队会话。
