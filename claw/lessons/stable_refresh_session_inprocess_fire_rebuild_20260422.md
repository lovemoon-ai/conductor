# Symptom

- 运行中的 fire task 点击 `restart session` 后，task card 可能短暂变成 `KILLED`，或者 refresh 被路由到错误 host。
- `refresh_session` 如果在 fire takeover / reconnect 窗口触发，web 端可能直接失败，即使真实 fire 仍在线。
- fire 端处理 refresh 时如果阻塞 websocket 下行，用户会在 refresh 卡住时连 `interrupt` / `stop` 都发不进去。

# Root Cause

- 原实现把 session refresh 建模成 daemon 侧 kill/spawn，混淆了 task/session 语义和 fire 进程语义，旧进程退出时会自然带出 `KILLED` 终态。
- refresh host 选择一开始主要依赖 task 行字段或过于乐观地信任 realtime 绑定，没有严格按真实 fire owner 收敛。
- SDK 下行分发默认串行 `await` handler，新加的 `refresh_session` 如果同步等待 rebuild 完成，就会把后续控制命令一起堵住。

# Fix

- 将 `refresh_session` 改为直接下发到 fire host，由 `conductor-fire` 在同一进程内关闭旧 `backendSession` 并用同一个 `sessionId` 做 resume 重建。
- web restart route 改为优先使用持久化 `executionHost`，只在缺失真实 fire owner 时回退到可信 realtime fire 绑定，并等待 `refresh_session` 专属 ack。
- `ConductorClient` 将 `refresh_session` 改成后台处理，ack 在 refresh 完成后单独提交，不再阻塞 `interrupt_turn` / `stop_task`。
- 补充回归测试覆盖 stale fire binding、non-blocking dispatch、fire-side in-process refresh 控制流。

# How To Avoid Next Time

- 设计 restart / refresh 语义时，先明确“task 不变、session 不变、PID 是否允许变化”，不要把不同层级的生命周期混在一起。
- fire/daemon 双 host 模型下，新命令必须先定义 owner 解析优先级，再实现投递逻辑；不能只复用旧 restart 路由。
- 对 websocket 下行控制命令，默认要检查 handler 是否会阻塞后续命令；长流程应拆成后台执行和独立 ack。
- 回归测试要显式覆盖 stale binding、takeover/reconnect 窗口、并发控制命令和 in-process rebuild。
