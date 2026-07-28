# Task bf4efb4f: kimi session 迟迟没有返回消息

- 日期: 2026-07-28
- 任务: `bf4efb4f-4f65-4439-826d-18e694bd73eb`(project 聚合, status=running)
- 诊断来源: live(`conductor diagnose`)+ 本机 fire/kimi 现场证据

## 结论(先说答案)

**kimi 后端没有挂,也没有被 ai-sdk 过滤掉任何本该展示的消息。** 根因是:kimi 正在执行一个超长的 agentic turn(13+ 分钟、37+ steps、41+ tool calls,持续写代码),整个 turn 内只产出了 `think` 思考内容和 tool calls,**没有任何 `text` 正文,也没有 `TurnEnd`**。而 ai-sdk 的 kimi 集成设计上只在 turn 结束(`prompt` request resolve)后才把缓冲的正文作为一条 `assistant_message` 上抛,turn 进行中只发 `working_status` 状态行。所以 web 端在整个长 turn 期间看不到任何 sdk 消息,表现为"迟迟不回"。

归属层:**执行层(provider 长 turn 未完成)**,非消息投递/路由/websocket 问题。

## 证据链

1. `conductor diagnose --json`(source=live):`diagnosis.code=likely_runturn_stuck`,outbox `status=acked`(15:53:02Z ack),`pending_age≈779s`,bound fire host `conductor-fire-unknown-host-70311` 在线。
2. fire_logs(daemon_host=macmini,log_path=`/Users/wangwang/ws/conductor/conductor.log`):`23:53:02 Processing message 4cca7fc5...(user)` 之后无该任务任何输出。
3. 本机进程:fire PID 70311(`conductor-fire.js --backend kimi`)与 kimi PID 70319(`kimi --wire --yolo --session=3a8cac98-2069-459d-aac9-72b77cce096c`)均存活。
4. kimi wire 日志 `~/.kimi/sessions/.../3a8cac98.../wire.jsonl` 持续写入(诊断时最后事件距当前仅 1 秒)。自 23:53 起事件统计:1 TurnBegin / 37 StepBegin / 41 ToolCall+ToolResult / 37 ContentPart(**全部 type=think,0 个 type=text**)/ 无 TurnEnd。ToolCall 内容为正常的功能实现(WriteFile/StrReplaceFile `project-card-groups` 相关文件),不是死循环。
5. ai-sdk `kimi-cli-session.js`(线上安装版 dist):
   - `ContentPart(think)` → 仅 `emitWorkingStatus(phase=reasoning)`,不进消息;
   - `ContentPart(text)` → `appendAssistantText` 缓冲,`runTurn` 中 `await transport.request("prompt")` resolve 后才 `finalizeAssistantMessage` → `emitAssistantMessage` 一次性上抛;
   - turn 超时守卫 `createTurnTimeoutGuard` 基于 activity(idle 超时),活跃 turn 不会被打断。

## 与 codex 路径的差异(UX gap)

conductor.log 显示 codex 任务在同一 turn 内可多次输出 `codex reply` 中间消息;kimi 集成则整 turn 只在结束时发一条。长 turn 下 kimi 任务在 web 上会长时间"静默",且本例 `task.latest_status_summary` 为 null,用户感知不到进展。

## 如何避免 / 后续建议

- 诊断此类问题时先看 `~/.kimi/sessions/<hash>/<session-id>/wire.jsonl` 的 mtime 和尾部事件,一分钟内即可区分"后端没产出"与"集成丢消息"。
- 产品层面可考虑:kimi turn 进行中把阶段性 `working_status`(含 step/tool 信息)更好地透出到任务卡片,或在 step 边界对已缓冲 text 做分段上抛,缓解长 turn 静默感。
- `likely_runturn_stuck` 的判定可结合 provider 侧活跃度信号(wire 日志仍在滚动)细分出 `long_turn_in_progress`,避免误判为"卡死"。
