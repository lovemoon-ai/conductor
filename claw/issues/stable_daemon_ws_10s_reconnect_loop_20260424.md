# Daemon websocket reconnect loop every 10 seconds

## Symptom

main 分支 daemon 每 10 秒断线一次、再重连，日志循环出现：

```
[conductor-daemon 2026-04-24T08:28:13] [daemon-ws] Disconnected from backend: reason=connection_lost close_code=1005 last_pong_at=2026-04-24T00:28:03.425Z last_message_at=2026-04-24T00:28:07.713Z (connected_at=2026-04-24T00:28:03.425Z last_pong_at=2026-04-24T00:28:03.425Z last_inbound_at=2026-04-24T00:28:07.713Z last_http_ok_at=2026-04-24T00:28:03.503Z last_presence_at=never)
[conductor-daemon 2026-04-24T08:28:23] Connected to backend
[conductor-daemon 2026-04-24T08:28:33] [daemon-ws] Disconnected from backend: reason=connection_lost close_code=1005 last_pong_at=2026-04-24T00:28:23.504Z (connected_at=2026-04-24T00:28:23.504Z last_pong_at=2026-04-24T00:28:23.504Z last_inbound_at=2026-04-24T00:28:07.713Z last_http_ok_at=2026-04-24T00:28:23.569Z last_presence_at=never)
[conductor-daemon 2026-04-24T08:28:43] Connected to backend
```

时间点完全规律：
- 08:28:03 connected
- 08:28:13 disconnected（10s 后）
- 08:28:23 reconnected（10s 后——正好等于 SDK `reconnectDelay` 默认值 10_000ms）
- 08:28:33 disconnected
- …

## 关键信号

1. `close_code=1005` — peer 发送 Close 帧但没带 status code。代码库里唯一会产生这种关闭的路径是 backend 的 `takeOverAgentHost`：
   - `web/src/lib/realtime/hub.ts:214` `conn?.close();`（不传参）
   - 经由 `web/src/lib/realtime/agent-gateway.ts:1142` `close: () => socket.close();`

2. `last_presence_at=never` — daemon 从未在 `/api/agents` 看到自己。说明连接确实还没稳定过。

3. `last_pong_at === connected_at` — 连接期间从未收到真正的 pong（heartbeat 间隔 20s，连接只活 10s，还没到发 ping 的时机）。

4. 连接只活 10 秒，watchdog grace period 是 35s，不可能是 daemon 自身的 watchdog 触发的。

## Root Cause 推断

几乎可以确定是 **两个 daemon 进程用同一个 `AGENT_NAME=m2` 和相同的 token 在抢连接**：

- `web/src/lib/realtime/agent-gateway.ts:1114-1118` 每个新连接进来时：
  ```ts
  if (realtimeHub.hasAgentHost(agentHost, user.id)) {
    const replacedCount = realtimeHub.takeOverAgentHost(agentHost, user.id);
    console.warn(`[agent-gateway] taking over existing agent host connection: ...`);
  }
  ```
- `takeOverAgentHost` 调用 `conn.close()`（无参），老连接收到 `close_code=1005`
- SDK `handleConnectionLoss` → 等 `reconnectDelay=10_000ms` → 重连
- 两侧周期相同，形成稳定的 10 秒震荡

可能的来源：
1. 同一机器上残留的旧 daemon 进程（lock 文件失效 / `--force` 启动多次）
2. 两台机器配置了同样的 `AGENT_NAME`（例如 `m2` 恰好被另一台机器也用了）
3. web UI / daemon CLI / 其他工具以 agent 身份连接时共用了 host header

## 待排查

- 在 backend 日志里 grep `[agent-gateway] taking over existing agent host connection: ... agentHost=m2`，每 10 秒应该会出现一次，就能确认 takeover 是不是在循环。
- 在用户机器上 `ps aux | grep conductor` 看有没有两个 daemon 进程。
- 确认 `AGENT_NAME` 的来源（env、config、hostname fallback），看看是否有冲突。
- 如果 backend 确实在循环 takeover，可以考虑：
  - 新连接进来时，如果对方 last message 距今小于阈值（比如 < 5s），拒绝新连接（返回 4002 duplicate-host），而不是 takeover
  - 或者在 `socket.close()` 时带上 `4003, "taken-over"` 这样的 code，让客户端识别到并退出/退避，避免立即重连

## Status

先观察，记录。暂不改动。
