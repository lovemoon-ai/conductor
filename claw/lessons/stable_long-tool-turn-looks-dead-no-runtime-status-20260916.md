# 长时间运行 tool 的 turn 在前端看起来像卡死

- Date: 2026-09-16
- Modules: `web/src/features/realtime/runtime-store.ts`, `cli/bin/conductor-fire.js`, `modules/ai-sdk/src/{client.js,shared.js,providers/*}`, `modules/conductor-sdk/src/client.ts`

## 症状

AI 连续几分钟到几十分钟在跑某个 tool（长 build、长测试、下载）时，前端状态栏不再更新；约 2 分钟后状态栏消失、Stop/Insert 按钮变灰，用户以为任务死了，但 AI 其实仍在工作。

## 根因

1. **前端 120s 看门狗静默清状态**：`REPLY_IN_PROGRESS_WATCHDOG_MS` 到点直接把 `replyInProgress` 置 false、清空 `statusLine`，把「长时间安静」误判成「丢了结束帧」。
2. **fire 去重吞掉重复状态**：provider 在 tool 运行期间反复发同一句（如 claude `tool_progress` → "claude running command"），fire 按签名去重后不再上报，服务端/前端收不到任何帧。
3. **tool 信息在 ai-sdk 归一化时被丢弃**：各 provider 事件流里有 tool 名和参数（claude `tool_use`、codex `item/started`、copilot `tool.execution_start` 等），但 `currentTurnStatus` 只保留一句笼统的 `status_line`，没法回答「现在在跑什么」。
4. **worker 队列阻塞中途状态**：fire 每次上报前 await `getSessionUsageSummary()`（缓存 2s），它在 worker 里是普通请求，排在正在执行的 `runTurn` 后面，turn 结束前不会返回。turn 开始 2 秒后的状态帧全部卡住，结束时才一起发出（用 fake provider 实测：调用在 turn 中挂起 >3s，改走 control 通道后 1ms 返回）。

## 修复

- ai-sdk：`shared.js` 新增 `noteToolStarted/noteToolFinished/withActiveTool`，8 个 provider 在 tool 开始/结束事件上登记；`getCurrentTurnStatus()` 带上 `active_tool {name, summary, started_at}`。`RemoteAiSession.fetchCurrentTurnStatus()` 与 `getSessionUsageSummary()` 走 control 通道，不再排在 `runTurn` 后面。
- fire：turn 进行中 60s 没有发出任何状态帧时，主动查询 provider 当前 tool，上报 `claude running Bash (3m): pnpm test`（≤100 字符，适配状态栏；时长放在参数前，移动端截断后仍可见），之后每 60s 一次（`CONDUCTOR_RUNTIME_HEARTBEAT_MS`）。心跳强制发送，且不更新去重签名，避免 provider 不变的周期状态把心跳行覆盖回笼统文字；查询期间若已有更新的帧（如结束帧）发出则放弃本次心跳，避免把已结束的 turn 重新标成进行中。
- 新增 `report_runtime_status` 下行命令 + `POST /api/tasks/:id/runtime-status`：前端打开任务/刷新页面/WS 重连时请求一次，fire 立即回报；没有 turn 在跑时把残留的 in-progress 帧落定为 false。
- 前端看门狗不再本地清状态，改为请求 fire 重新上报并继续计时；真正死掉的 fire 由 stale recovery 收敛。

## 如何避免

1. **「没有消息」≠「死了」**：任何基于静默的超时判断，先主动向执行端要状态，再下结论；不要在客户端单方面清状态。
2. **状态去重要配合心跳**：对「内容不变但仍在进行」的状态做去重时，必须有带变化字段（如已运行时长）的定期心跳，否则下游看到的就是静默。
3. **worker 请求分道**：只读、快速的查询（状态、用量）必须走 control 通道，普通请求队列会被长时间 `runTurn` 独占。新加 worker 方法时先问：turn 进行中会不会被调用？
4. **归一化别丢关键上下文**：provider 事件归一化时保留「当前在做什么」的结构化字段，而不是只留展示文案。
5. **用真实 SDK 输出校验事件形状**：claude 长 Bash 的 `tool_progress` 心跳 `tool_use_id` 是 `<id>-heartbeat-N`（真实 id 在 `parent_tool_use_id`），只看类型定义/手写 fixture 会误把每次心跳当成新 tool。
