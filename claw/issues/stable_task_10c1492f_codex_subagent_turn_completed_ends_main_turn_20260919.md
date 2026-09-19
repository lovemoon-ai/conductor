# stable: 任务 10c1492f 回两条就“停了”——codex 子 agent 的 turn/completed 被当成主轮结束（2026-09-19）

- 任务：`10c1492f-4bae-4a02-859c-09064086ab4a`（project `vln-objnav-search`，owner `019aceb3…`），backend `codex`（gpt-6-astra，multi-agent 模式）
- fire：`conductor-fire-l20-10c1492f…`，CLI **0.12.0**；daemon `l20`
- 诊断方式：`conductor diagnose` 查不到（别人的任务，返回 404），改用生产 DB 只读查询 + `/opt/conductor/conductor.log` + 通过 owner 共享给我们的 daemon `shared-2620-l20` 只读查看 codex rollout JSONL
- 层级：**执行层 / provider 集成**（`modules/ai-sdk` codex app-server 会话），不是 websocket、路由或投递问题
- 状态：已修复（`handleNotification` 按 threadId 过滤），见 `claw/lessons/stable_codex_subagent_turn_completed_ends_parent_turn_20260919.md`

## 结论先行
AI 没有卡住，也没有停。codex 把第一轮完整跑完了（11:37:49 CST 写出 `final_answer` 和 `task_complete`），但 Conductor
在 11:34:21 就已经认为这一轮结束了，之后主线程的 3 条中间消息和最终答案全部被丢掉。

原因：这一轮 codex 用 `spawn_agent` 起了 3 个子 agent。app-server 把**子 agent 线程**的 `turn/started`、`item/*`、`turn/completed`
通知也推到同一条连接上，而 `codex-app-server-session.js` 的 `handleNotification` 完全不看 `threadId`：
1. `turn/started` 无条件执行 `currentTurn.turnId = <子 agent 的 turnId>`，覆盖了主轮的 turnId；
2. 之后主线程的 `item/*` 事件 turnId 对不上，`ensureCurrentTurn` 返回 null，被**静默丢弃**；
3. 第一个结束的子 agent 发出 `turn/completed`：turnId 匹配不上，但走到了“非 goal 模式任何 `turn/completed` 都回退到
   `this.currentTurn`”的兜底分支（来自 `stable_codex_turn_completed_stuck_composing_20260728` 的修复），于是主轮被 resolve，
   `codex finished`，`currentTurn = null`；
4. 之后主线程的所有输出（包括最终答案）都因为 `currentTurn` 为空而被丢弃。没有报错，也没有失败消息，所以用户只看到 AI“停了”。

## 时间线（CST；codex 时间来自 rollout JSONL，Conductor 时间来自 `messages`）
| 时间 | codex 主线程 / 子 agent | Conductor 看到的 |
| --- | --- | --- |
| 11:30:22 | 主轮开始（turn `…99f8f68b04c5`） | |
| 11:30:29 | 主 commentary #1 “我会先读交接文档…” | 11:30:51 落库 |
| 11:30:54 | 主 commentary #2 “🥷 我会按深度审查…” | （暂存在 active message 中） |
| 11:30:59 / 11:31:06 / 11:31:13 | `spawn_agent` ×3：expert_architecture(Jason)、instruction_assumptions(Schrodinger)、scoring_composition(Erdos)；每个子 agent 的 `turn/started` 都覆盖了 turnId | |
| 11:32:13、11:33:56 | 主 commentary #3、#4 | **丢失** |
| **11:34:21** | **expert_architecture 子 agent `task_complete`** | **11:34:21 刷出 #2，这一轮被标记为结束** |
| 11:35:26 / 11:36:27 / 11:36:30 | 其余子 agent 结束 | |
| 11:36:06 | 主 commentary #5 “还核实了一个实际导出问题…” | **丢失** |
| **11:37:49** | **主 `final_answer` + `task_complete`** | **丢失** |
| 11:43:19 | 生产 web 重启（0.13.2 部署） | 与本问题无关，此时这一轮早已结束 |
| 13:14:29 | 用户发“继续” | |
| 13:14:51 | 主 commentary “我继续审查…” | 13:17:46 落库（被 Erdos 的消息 item/started 刷出） |
| 13:16:57 | 主 commentary “继续查到了两个…” | **丢失** |
| **13:18:25** | **scoring_composition(Erdos) 子 agent `task_complete`** | **13:18:25 把 Erdos 的子 agent 报告（“新增 3 个可复现的监督问题…”）当作 AI 回复落库，这一轮被标记为结束** |
| 13:20:15、13:21:40 | 主 commentary、主 `final_answer` | **丢失** |
| 13:25:43–13:28:43 | 第三轮，**没有起子 agent** | 3 条全部正常落库 |

第二轮更严重：用户看到的“结论”其实是子 agent Erdos 的报告，不是主 AI 的最终答案。

## 排除项
- 服务器重启：第一轮在重启前 5 分半钟就已经在 codex 侧结束；同一窗口内其他 fire 的消息都正常落库。
- 投递层：`agent_outbox` 三条（create_task、两条 task_user_message）都在同一秒 acked；SDK `sendMessage` 走持久化
  HTTP outbox，5xx/网络错误会重试。本例消息根本没有进入 `sendMessage`。
- 720s 空闲 deadline：没有触发（没有失败消息，并且 turn 已经被提前 resolve）。

## 证据位置
- 代码（v0.12.0 与 HEAD 一致）：`modules/ai-sdk/src/providers/codex-app-server-session.js`
  - `this.transport.on("notification", …)` → `handleNotification`，没有线程过滤
  - `case "turn/started"`：`if (turnId) currentTurn.turnId = turnId;`，无条件覆盖
  - `ensureCurrentTurn`：非 goal 模式下 turnId 不匹配就返回 null
  - `case "turn/completed"`：非 goal 模式下有“回退到 `this.currentTurn`”的兜底分支
- l20 上的 rollout：主线程 `rollout-2026-09-19T03-30-22-01a0b7b7-0e06-…jsonl`；子 agent 为 `03-30-59-…9f09…`、`03-31-06-…bb8d…`、
  `03-31-13-…d624…`（`session_meta.source.subagent.thread_spawn.parent_thread_id` = 主线程 id）

## 修复方向（第 1、4、5 条已实现；子 agent 的事件已经被挡在外面，第 2、3 条不需要再单独改）
1. `handleNotification` 按 `params.threadId` 过滤：只把主线程（`this.sessionId`）的事件用于 turn/消息状态机；子 agent
   线程的事件最多转成 working status（例如“子 agent X 运行中”），绝不能 resolve 主轮或产出 sdk 消息。
2. `turn/started` 在非 goal 模式下，如果已经绑定了 turnId，就不要再覆盖。
3. `turn/completed` 的兜底回退只对主线程生效，不能被别的线程触发（否则会和 07-28 的修复冲突，需要两者兼顾）。
4. 测试：用 fake app-server 模拟“主轮 spawn 子 agent，子 agent 先 `turn/completed`，主线程后出 final_answer”的交错时序，
   断言主轮只在主线程 `turn/completed` 时 resolve、最终答案被送出、子 agent 的消息不进 transcript。
5. 修复前需要确认：app-server v2 的 `turn/*`、`item/*` 通知确实带 `threadId`（rollout 中的 `item_completed` 带 `thread_id`）。

## 次要观察（未深挖）
主线程 commentary 的落库时间比 codex 写出时间晚 22 秒到 3 分钟，看起来要等下一条 assistant item 开始或者 `turn/completed`
才会被刷出，`item/completed` 没有及时 finalize。原因是 `resolveItemPhase` 不认识 v2 的 `type: "agentMessage"`，所以消息边界只能靠下一条
delta 的 itemId 变化或 `turn/completed` 来判断。这是另一个问题，不影响本结论，但会让长轮次显得“卡顿”，留作后续处理。

## 用户侧
这个任务当前没有卡住。丢失的两份最终答案仍然在 l20 的 codex rollout 里（11:37:49、13:21:40），但 UI 上看不到。用户可以让 AI
“把上一轮的最终结论再发一遍”；或者在修复上线前，避免在 Conductor 的 codex 任务里触发多 agent 深度审查（`check` 技能的 🥷 模式）。
