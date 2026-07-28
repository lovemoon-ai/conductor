# stable: Kimi 一轮结束后卡在 "Kimi is writing the reply" (BUG-R6-01)

## 症状
Kimi 回答已经完整显示出来、这一轮在 wire 上也已 `TurnEnd`，但 Web 上的 "Kimi is writing the reply" 状态条一直不消失，输入框停在 interrupt/insert 模式（表现为发送被"锁住"），需刷新页面才恢复。间歇复现。commit `fcd9cdb`（StepBegin 处提前 flush 文本）之后更明显——用户看到"回答已出但还在写"。

## 根因
`reply_in_progress` 只在 kimi 的 `prompt` JSON-RPC promise **resolve 时**才被清（`runTurn` 末尾调用 `emitTerminalWorkingStatus(reply_in_progress:false)`）。而 wire 的 `TurnEnd` 事件只是 `currentTurn.seenTurnEnd = true`，不发任何清除状态。

当最后一个 `ContentPart(text)`（phase=`message_aggregation`, "Kimi is writing the reply", `reply_in_progress:true`）和 `TurnEnd` 已经到达、但 `prompt` RPC 响应被延迟/丢弃/竞态时，`runTurn` 一直阻塞在 `await transport.request("prompt")`，永远到不了终态清除 → Web 端 `replyInProgress` 无限期为 true。kimi 是 session-file-reply-stream 后端，fire 侧的 DONE 清除被 `if (!useSessionFileReplyStream)` 跳过，也不兜底。客户端/fire 均无 watchdog 使陈旧状态过期。

## 修复
把终态清除**从 prompt RPC 解耦，改在 `TurnEnd` wire 事件处发出**（`modules/ai-sdk/src/providers/kimi-cli-session.js` 的 `case "TurnEnd"`）：flush 缓冲文本后调用 `emitTerminalWorkingStatus({ phase:"turn_completed", status_done_line:"Kimi finished" })`。`emitTerminalWorkingStatus` 本身幂等（`terminalWorkingStatusEmitted` 守卫），所以 `runTurn` 末尾原有的调用在 prompt 稍后 resolve 时变成无害 no-op。这样清除依赖的是 wire 可靠发出的 `TurnEnd`，而非可能被 hang 的 RPC 响应。

> 运行副本是 dist/vendored 构建：需 `cd modules/ai-sdk && npm run build` 重建 `dist/`，vendored 的 `cli/node_modules/.pnpm/@love-moon+ai-sdk@*/dist/...`（与主仓 dist 硬链接）随之更新，改动才在运行时生效。dist 已 gitignore，源码入库即可。

## 如何避免
- **"清除进行中状态"这类终态信号要绑在可靠、必到的事件上（wire 的 `TurnEnd`），不要绑在可能延迟/丢失/竞态的 RPC 响应上。**
- 幂等的终态发射（带一次性守卫）让"多路径都发一次清除"成为安全的兜底策略，应作为默认写法。
- 对于 session-file-reply-stream 类后端，fire 侧不兜底清除，后端 session 必须自己保证终态；新增此类后端时要覆盖"回答已出但 RPC 未 ack"的场景。
- 可考虑再加客户端 watchdog（`replyInProgress` 长时间无新事件则本地清除）作为防御纵深，避免任何未来"丢失清除"场景把 UI 卡死。
