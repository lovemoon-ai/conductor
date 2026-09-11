# kimi print 模式硬墙钟超时：长任务必被杀（12 分钟精确命中）

- Date: 2026-09-10
- Module: `modules/ai-sdk/src/providers/kimi-print-session.js`
- Surfaced by: 线上任务 `34604502-dfc2-4df6-b27c-ef98525845d3`（"HUG [kimi]"，host=apex）反复出现 `kimi 处理失败: Kimi print turn timed out`，每次都精确命中 turn 开始后 12 分钟
- 诊断存档: `claw/issues/stable_task_34604502_kimi_print_turn_hard_timeout_20260910.md`

## 症状

用户消息进入后 kimi 正常干活，但 turn 进行到 12 分钟整时被 SIGTERM 杀掉，用户收到 `kimi 处理失败: Kimi print turn timed out`。该任务是装环境（torch 7.5G venv、权重下载、uv build），单 turn 必然超 12 分钟，因此"总是"超时，任务事实上无法完成。conductor 投递层（outbox ack、fire 绑定）全部正常。

## 根因

- print 模式（KimiPrintSession，apex 上 kimi CLI 不支持 `--wire` 时的 fallback）的 turn 超时是 **spawn 时起的硬墙钟定时器**（`setTimeout(turnDeadlineMs)`），到点无条件杀进程，完全不看 turn 是否活跃。
- wire 模式（kimi-cli-session）的 `createTurnTimeoutGuard` 是基于 `currentTurnActivityAt` 的 idle 超时，活跃 turn 不会被杀。两种模式的超时语义不一致，是这个 bug 的架构根源。

## 修复

把 print 模式的 turn deadline 改为与 wire 模式对齐的 activity-based idle 超时：

- stdout（stream-json 事件）/ stderr（工具输出）每收到一行非空输出即重置 idle 时钟；
- 定时器到点时重新检查 idle 时长，不足 `turnDeadlineMs` 则顺延；
- 只有完全静默超过 deadline 的 turn 才被 SIGTERM 回收。

错误消息与 `reason: "turn_timeout"` 保持不变，上游无感知。新增 `test/kimi-print-session.test.js` 两个用例（心跳 turn 不被杀 / 静默 turn 如期超时），ai-sdk 223 + manager 81 + cli fire 85 测试全绿。

## 如何避免

1. **新 provider/session 实现 turn 超时时，一律用 idle-based 守卫，不要用硬墙钟**。加新 backend 时对照 wire 模式的 `createTurnTimeoutGuard` 语义。
2. 诊断 "timeout" 类问题时，先看 turn 时长是否精确等于默认 deadline（12 分钟）——精确命中即硬超时类 bug，区别于 idle 卡住和网络问题。
3. 残余风险已记录：「吵但卡死」的进程（stderr 持续输出）不再有绝对上限，与 wire 模式语义一致；如未来需要可加绝对上限兜底。
