# Symptom

- `refresh_session` 有时会在 web 端返回超时或失败，但 daemon 后续仍可能把 session 重启成功。
- daemon 在 refresh 过程中遇到 shutdown 或 replacement child 快速退出时，可能留下孤儿进程、错误的 `RUNNING` 状态，或者丢失终态上报。

# Root Cause

- web route 在等待 ack 前就持久化了 `restart_task` outbox，但 ack timeout 时没有把该命令收口，导致后续 outbox replay 还能再次投递旧请求。
- daemon 只在 refresh stop 之前检查 `daemonShuttingDown`，stop/wait 之后没有再次 gate，shutdown 竞态下仍可能继续 spawn replacement child。
- replacement child 的 `error` / `exit` 监听注册晚于 `RUNNING` 状态和 accepted ack，快失败窗口内会漏掉退出事件。

# Fix

- refresh ack timeout 时，将对应 outbox 行标记为 `failed`，阻止继续 replay。
- refresh stop/wait 结束后再次检查 `daemonShuttingDown`，shutdown 中途进入时直接 NACK，不再 spawn 新 child。
- 将 replacement child 的流、`error`、`exit` 监听前置到 `RUNNING` / ack 之前；如果 child 在 startup ack 前退出，先发终态，再返回 rejected ack。
- 增加回归测试覆盖 ack timeout、shutdown-during-refresh、replacement child fast-exit 和 stop-timeout delayed-exit。

# How To Avoid Next Time

- 任何“持久化命令 + 同步等待 ack”的流程，都必须定义 timeout 后如何让持久化命令失效，不能只给前端返回超时。
- stop/wait/spawn 这类多阶段 daemon 流程，在每个跨 `await` 的阶段边界都要重新检查 shutdown 状态。
- 对 child process 来说，监听器必须早于任何可能阻塞的上游 I/O 或 ack 发送。
- 回归测试不要只覆盖 happy path；需要显式测 timeout、replay、shutdown、fast-exit 和 mixed ownership 场景。
