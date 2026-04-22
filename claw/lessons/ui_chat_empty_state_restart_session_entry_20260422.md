# Symptom

- 运行中的 AI task 如果还没有任何消息，聊天页没有 `refresh_session` 入口。
- 当 session 在首条消息之前就卡住时，用户只能离开当前上下文，无法直接在聊天页内刷新 AI session。

# Root Cause

- `refresh_session` 入口只挂在消息气泡的底部操作栏上。
- 聊天空态没有复用 restart 行为，也没有补一个与当前任务上下文绑定的 fallback 入口。

# Fix

- 在聊天空态下为 running AI task 增加 `Restart AI session` 按钮，直接走 `restartMode: 'refresh_session'`。
- 增加组件测试覆盖“无消息但 task 仍 running”时的 restart 入口。

# How To Avoid Next Time

- 新交互如果依赖列表项或消息项存在，必须同时检查 empty state 是否还有可达入口。
- 对 task-level 操作，优先保证在 task detail 的主上下文里始终可达，而不是只挂在某一类内容项上。
- UI 回归测试要覆盖空态、加载态和正常态，不要只测列表已有内容的场景。
