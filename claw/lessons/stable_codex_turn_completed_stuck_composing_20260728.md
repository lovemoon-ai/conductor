# stable: Codex 回复已出却卡在 "codex composing reply"（OBS-R8-02 / BUG-R6-01 同族）

## 症状

即时发送的一轮，Codex 的精确回复已经完整显示，但 Web 输入区一直停在
`codex composing reply`，>90s 不消失，输入框停在 interrupt/insert 模式（发送被
"锁住"），刷新页面才恢复；同任务下一轮正常。间歇复现，QA Round 8 只见一次。

## 根因

Codex app-server 的"进行中"终态清除是**单点、无兜底**的：

- 仅在 `modules/ai-sdk/src/providers/codex-app-server-session.js` 的
  `turn/completed` wire 事件里发出 `reply_in_progress:false / "codex finished"`
  并 resolve 这一轮；且被 `ensureCurrentTurn()` 挡了一道，返回 null 就**早退**，
  清除彻底不发。
- `turn/start` RPC 立即返回 `status:"started"`（见
  `fixtures/fake-codex-app-server-goals.js`），无法充当终态兜底信号——终态**只能**
  靠 `turn/completed` 这一条通知。
- 前端 `web/src/features/realtime/runtime-store.ts` 的 `replyInProgress` 完全由收到
  的 working-status 驱动，且是组合器 interrupt/send 模式的唯一开关。

因此只要那条 `reply_in_progress:false` **任一环节丢失**（会话没发 / 早退跳过 /
realtime 帧在投递中丢），组合器就一直卡住。唯一的自动兜底是后端 `turnDeadlineMs`
默认 **12 分钟** 的 idle 超时才补发清除——用户等不到，只能刷新（刷新会重新拉状态从而
恢复）。这与 BUG-R6-01（Kimi 卡 writing）完全同族；当时给 Kimi 加了"绑可靠事件 +
幂等兜底"，但 codex 侧从未补这层防御。

## 修复（纵深防御，两层）

1. 后端幂等加固（`codex-app-server-session.js`）：
   - 新增幂等 `emitTurnCompletedStatus(currentTurn, …)`，以 `terminalStatusEmitted`
     一次性守卫，保证"多路径都发一次清除"是安全 no-op。
   - `turn/completed` 在非 goal 模式下即使 `ensureCurrentTurn()` 返回 null，也回退到
     `this.currentTurn`（非 goal 只有一轮），不再把清除跳过。
   - `runTurn` 成功返回前再幂等清一次，作为 belt-and-suspenders。
   - goal 模式的严格匹配逻辑不变。

2. 前端 watchdog（`runtime-store.ts`）：`replyInProgress=true` 后启动看门狗，任何
   status/message 活动都会重置；若活动静默超过
   `REPLY_IN_PROGRESS_WATCHDOG_MS`（120s）仍为 true，则本地清除——等价于自动做一次
   "刷新恢复"，无论清除丢在哪一层都能兜住。消息流入也通过 `noteActivity()` 重置，
   避免长回合误清。

## 如何避免

- 终态清除（"停止进行中"）要绑在可靠、必到的事件上，并做成**幂等**，让多路径重复
  发射成为安全兜底——这是默认写法，不是可选项。
- 新增/维护一个后端 provider 时，凡是"进行中状态由某个终态事件清除"的，都要检查
  "该事件丢失/未匹配"场景，并对照已有 provider（Kimi 的 BUG-R6-01）补齐同款防御。
- UI 的 busy 开关若完全依赖实时事件，应配一个层无关的 watchdog 兜底，把最坏卡死时间从
  "后端 idle 超时/手动刷新"降到秒级，防止任何未来"丢清除"场景卡死组合器。
- 运行副本是 dist/vendored 构建：改完 `modules/ai-sdk/src` 需
  `cd modules/ai-sdk && npm run build` 重建 `dist/`，vendored 的
  `cli/node_modules/.pnpm/@love-moon+ai-sdk@*/dist/...`（与主仓 dist 硬链接）随之生效。
