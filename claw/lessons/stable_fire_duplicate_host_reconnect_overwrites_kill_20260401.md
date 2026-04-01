# stable: fire duplicate-host reconnect can overwrite kill convergence (2026-04-01)

## Symptom

线上 fire task 在 app 侧点击 kill 后，`stop_task` 已经送达 fire，但 task 仍可能停留在 `running`，并且最近状态摘要显示为 `conductor fire reconnected`。

## Root Cause

- fire websocket 在 `duplicate-host` 场景下会被后端反复关闭；
- 客户端会立刻重连，形成 reconnect storm；
- fire 的 reconnect recovery 会在重连成功后再次上报 `RUNNING`；
- kill 触发后，如果最终 `KILLED` 状态提交失败或退出前没有等 durable upstream flush 完成，task 会被留在 `running`；
- 服务端原先对同 host 新连接直接拒绝，而不是让新连接接管旧连接，进一步放大了 `duplicate-host` 窗口。

## Fix

- fire 在 stop/shutdown 期间跳过 reconnect recovery，不再重新写回 `RUNNING`；
- fire 退出前对 pending upstream 事件做有界 flush，尽量确保最终 `KILLED` 被提交；
- websocket client 对 `duplicate-host` 加入重连退避，避免 tight loop；
- agent gateway 对同 `user + host` 的新连接执行 takeover，关闭旧连接后注册新连接，而不是直接拒绝。

## How To Avoid Next Time

- reconnect recovery 只能在“任务仍应继续运行”时触发，不能无条件写 `RUNNING`；
- fire 终态上报不能只“尝试一次然后退出”，需要和 durable outbox flush 联动；
- 对同 host 重连不要只做冲突拒绝，应该明确设计 ownership handoff；
- 对 kill / reconnect / final-status convergence 这三条链路要有组合回归测试，而不是只测单一路径。
