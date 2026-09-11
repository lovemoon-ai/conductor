# stable: 任务 34604502 kimi 反复提示 "Kimi print turn timed out"（2026-09-10）

## 症状
- 线上任务 `34604502-dfc2-4df6-b27c-ef98525845d3`（"HUG [kimi]"，host=apex）多次出现 `kimi 处理失败: Kimi print turn timed out`。
- 时间点：04:27:05、05:11:33、05:23:35（UTC），每次都恰好是 turn 开始后 ~12 分钟。

## 诊断过程（live，`conductor diagnose --json` + 消息历史）
- `diagnosis.code = no_pending_user`：投递层正常，4 条 `task_user_message` outbox 全部秒级 `acked`，fire host `conductor-fire-apex-34604502-...` 在线。问题不在 websocket / 路由 / outbox 层。
- `fire_logs`（apex `/mnt/data1/min.du/ws/fires/2026-09-10/12-12-21_fork_34604502/conductor.log`）显示 daemon 用的是 `[kimi-print]` 模式：`spawn kimi --output-format=stream-json --session=... --prompt ...`。
- 消息时间线与 12 分钟硬超时精确吻合：
  - 04:15:03 用户消息 → kimi 持续干活（克隆 HUG、写补丁、下权重、装 torch）→ 04:27:05 超时（12m02s）
  - 04:59:32 "进展？" → 回复后继续干活 → 05:11:33 超时（12m01s）
  - 05:11:33 重试的 turn → 05:23:35 超时（12m02s）

## 根因
- 该机器 daemon 跑的是 **KimiPrintSession（Kimi Code prompt 模式）**（apex 上 `kimi --help` 探测不到 `--wire`、含 `--prompt`+`--output-format`，见 `modules/ai-sdk/src/providers/kimi-cli-mode.js`）。
- print 模式的 turn 超时是**硬墙钟定时器**：spawn 时 `setTimeout(turnDeadlineMs)`，到点 SIGTERM 杀 kimi 进程，**不看任何活动信号**（`modules/ai-sdk/src/providers/kimi-print-session.js` L619-649）。默认 `DEFAULT_TURN_DEADLINE_MS = 12 * 60 * 1000`，可通过 `CONDUCTOR_TURN_DEADLINE_MS` 调整（上限 30 分钟）。
- 本任务内容是装环境（torch 7.5G venv、模型权重下载、uv build），单 turn 必然超过 12 分钟，所以"总是"被杀。kimi 只能用 nohup 后台任务绕，但新 turn 跟踪后台任务又会再次超 12 分钟。
- 对比：wire 模式（`kimi-cli-session.js` 的 `createTurnTimeoutGuard`）基于 `currentTurnActivityAt` 做 idle 超时，活跃 turn 不会被杀。print 模式没有等价机制。

## 处理建议
- 短期（apex 运维侧）：给 daemon 设置 `CONDUCTOR_TURN_DEADLINE_MS=1800000`（上限 30min）；或把 apex 的 kimi CLI 换成支持 `--wire` 的版本，走 wire 模式的 idle-based 守卫。
- 长期（arch）：KimiPrintSession 的 turn deadline 应改为 activity-based（stdout/stderr/工具事件有活动就顺延），与 wire 模式行为对齐。

## 修复状态
- 已按长期方案修复（2026-09-10）：`kimi-print-session.js` 的 turn deadline 改为 activity-based idle 超时（stdout/stderr 有输出即重置计时），新增 `test/kimi-print-session.test.js` 两个用例（活跃 turn 不被杀 / 静默 turn 仍超时）。ai-sdk 223 + cli fire 85 等测试全绿。

## 如何避免
- 诊断 kimi/codex "timeout" 类问题时，先看 turn 时长是否精确等于 12 分钟默认值——精确命中即 print 模式硬超时，区别于 wire 模式 idle 超时和网络问题。
