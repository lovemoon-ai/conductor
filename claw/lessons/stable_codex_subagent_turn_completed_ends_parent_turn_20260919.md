# stable: codex 起子 agent 后，任务回两条就“停了”（任务 10c1492f，2026-09-19）

## 症状
一个 codex 任务（gpt-6-astra，multi-agent 模式，`check` 技能的深度审查）在回了两条进度说明后就不动了。用户隔了 1.5 小时发“继续”，
AI 才接着做。第二轮界面上显示的“结论”其实是子 agent 的报告；主 AI 的最终答案在两轮里都没出现。没有任何报错。

## 根因
codex app-server 会把 `spawn_agent` 起的子 agent 线程的 `thread/started`、`turn/*`、`item/*` 通知推到同一条连接上，每条都带自己的
`threadId`。`codex-app-server-session.js` 的 `handleNotification` 不看 `threadId`：
- 子 agent 的 `turn/started` 覆盖了主轮的 `currentTurn.turnId`，之后主线程的 delta 因为 turnId 对不上，被 `ensureCurrentTurn` 丢掉；
- 第一个结束的子 agent 发出 `turn/completed`，命中了非 goal 模式下“任何 `turn/completed` 都回退到 `this.currentTurn`”的兜底分支
  （来自 `stable_codex_turn_completed_stuck_composing_20260728.md`），于是主轮被 resolve，`currentTurn = null`；
- 从这之后主线程的输出全部被丢弃。子 agent 的 delta 在 turnId 被它覆盖后是能匹配上的，所以它的报告会被当成 AI 回复送出去。

证据：Conductor 最后一条消息落库时间与第一个子 agent 的 `task_complete` 在同一秒（03:34:21Z）；codex rollout 显示主线程到 03:37:49Z
才写出 `final_answer`。详见 `claw/issues/stable_task_10c1492f_codex_subagent_turn_completed_ends_main_turn_20260919.md`。

## 修复
`handleNotification` 开头增加过滤：`params.threadId` 存在且不等于 `this.sessionId` 时，只调用 `touchTurnActivity()`
（主 AI `wait` 子 agent 期间不至于触发 12 分钟空闲期限），不再推动轮次或消息状态。`thread/started` 如果带 `parentThreadId`（协议规定
只有子 agent 才会设置），就不再用它覆盖 `sessionId`。测试：`modules/ai-sdk/test/codex-app-server-session-subagent.test.js`
按事故中的事件顺序回放。

## 如何避免
- provider 会话必须按“会话身份”（thread/session id）过滤上游事件，不能假设一条连接上只有自己的事件。协议里有 id 就要校验。
- 加“兜底终态”时（例如“turnId 对不上也结束当前轮”），先想清楚：还有谁会发同类事件？兜底会不会被别人的事件触发？
- 上游 CLI 引入新的并发能力（multi-agent、review、compact 子线程）时，用真实的 app-server 流量回放一遍会话层的状态机。
