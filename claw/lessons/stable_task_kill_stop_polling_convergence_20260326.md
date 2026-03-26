# stable: task kill should actively converge terminal status after stop dispatch (2026-03-26)

## Symptom

用户点击 kill 后，接口先返回 `Timed out waiting for task ... to stop on ...` 或 `task daemon ... is offline`，但刷新页面后同一个 task 又显示为 `killed`。

## Root Cause

`PATCH /api/tasks/[taskId]` 的普通 task kill 路径此前采用“先把 task 写成 `killed`，再等待 daemon stop ack / final status”的模型。

这会带来两个问题：

- 如果 fire 没有在短超时窗口内返回 final status，接口会报错并回滚，用户看到 `Failed to kill task`
- 如果随后 host 掉线，`recoverStaleDisconnectedAgentTasks()` 又会在后续刷新时把该 task 补偿收敛成 `killed`

结果就是“本次 kill 失败”和“后续 stale recovery 收敛为 killed”混在一起，用户感知为前后矛盾。

## Fix

将普通 task 的 kill 流程改为：

- 先发送 `stop_task`
- 在更长的窗口内主动轮询 task 实际状态
- 轮询期间如果 host 已离线，主动触发一次 stale recovery
- 只有确认 task 已进入终态后，才把接口返回为成功并持久化 `killed`

同时补充回归测试，覆盖 stop waiter 超时后由主动轮询发现 `killed` 的场景。

## How To Avoid Next Time

对于“远端停止 + 最终状态收敛”这类链路，不要只依赖一次短超时的 ack/final-status waiter，也不要先乐观写入终态再等待远端确认。

更稳妥的做法是：

- 把“控制命令已发出”和“任务已进入终态”分开处理
- 在有限窗口内主动检查真实 task 状态
- 对离线 host 结合 stale recovery 做补偿收敛
- 在 UI 和接口语义上区分 stop timeout、host offline、recovery converged 这几类结果
