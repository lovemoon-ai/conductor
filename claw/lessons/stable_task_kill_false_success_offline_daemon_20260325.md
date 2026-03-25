## Symptom

Task card 上点击 `running -> killing?` 后，某些运行中的 task 会直接显示 `killed`，但实际上没有任何 daemon 收到 `stop_task`，任务仍可能在后台继续运行。

## Root Cause

`PATCH /api/tasks/[taskId]` 在处理 `status = killed` 时，会先把数据库里的 task 状态写成 `killed`，再尝试向 daemon 发送 `stop_task`。

之前只拦住了“完全没有 host 绑定”的情况，没有拦住“task 还带着一个 host 字符串，但对应 daemon 已离线”的情况。这个分支里 stop 发送不会真正送达，但接口仍然返回成功，导致前端误以为 kill 完成。

## Fix

对 card kill 这条路径增加了严格校验：

- 没有可用 host 绑定时，直接返回 `409`
- 有 host 但 daemon 已离线时，也直接返回 `409`
- 只有在目标 daemon 仍在线时，才允许继续 stop 流程并保留 `killed` 状态

同时补了回归测试覆盖：

- running task + no host
- running task + offline host

## How To Avoid Next Time

对于“先改本地状态，再发远端控制命令”的接口，不要只校验是否存在 host 字符串，还要区分：

- 是否真的有可路由的目标
- 目标 daemon 是否在线
- 控制命令是否至少成功进入可确认的传输路径

否则 UI 很容易出现“本地状态成功、远端实际未执行”的假成功问题。
