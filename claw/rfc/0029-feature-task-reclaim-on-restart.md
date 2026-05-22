# 0029 Task Reclaim on Restart

## Status

Proposed

## Owner

dang217 (15711406152@163.com)

## Date

2026-05-23

## Summary

当一个 `ai_task` 因为 daemon 失联（典型场景：宿主机被睡眠 / 网络抖动 / 代理半死）而被防御性标记为 `killed` 时，对应的 `conductor-fire-*` 子进程通常仍然活在 tmux 会话里、TCP 也还连着 backend——只是控制面与 task 的 DB 状态对不上。当前 restart 路径会无差别地走 `resume_inplace` 重新 spawn 一个全新的 fire，**忽略掉真正还在跑的老 fire**，进而产生"老 fire 漂在 tmux 里 / restart 失败 / 用户重复点击 / hub 累积 stale binding"的恶性循环。

本 RFC 提出在 restart 路径中引入一次 **Reclaim 探活**：在 spawn 新 fire 之前，先尝试和"被认为已死"的老 fire 握一次手；活着就续约，死了再 fallback 走现有的 spawn 路径。同时为 task 增加 `killed_reason` 字段，把"用户显式停止"和"系统防御性兜底"两种死法区分开，让 reclaim 只在后者上发生。

## Context

### 触发场景的具体复盘

以线上 task `8a44515f-0f11-49de-8b61-87125465f962` 为例（详见 `claw/issues/stable_03e46a46_restart_loop_fire_ws_watchdog_20260515.md` 和这次会话的诊断记录）：

| 时刻 | 本机 | backend |
|---|---|---|
| T0 | daemon m1 + fire 69994 正常工作 | task=running，hub 绑定 fire-69994 |
| T1 误按睡眠 | 进程冻结，TCP 不再响应 keepalive | pong 超时 → 把绑定到 m1 的 task 标 **killed** |
| T2 唤醒 | daemon ws 进入"心跳通业务帧不通"半死状态；fire 69994 **完好无损**仍在 tmux 里 | task 已 killed in DB；hub 还认得 fire-69994 |
| T3 用户点 restart | web API 写 outbox → 半死的 daemon ws 收不到 / 内存里 dedup 表挡掉 → 即便走通也会 spawn 新 fire | task.status 无法转 running；UI 体验为"restart 不响应" |

老 fire 仍然在等下一条消息，但 backend 已经把它"判死刑"了。

### 当前 restart 路径的关键假设

`web/src/app/api/tasks/[taskId]/restart/route.ts` 的 `isInplaceRestart` 分支（约 524 行）：

```ts
await tx.agentOutbox.create({
  data: {
    eventType: "restart_task",
    payloadJson: JSON.stringify({
      type: "restart_task",
      payload: { mode: "resume_inplace", source_task_id, target_task_id, ... },
    }),
    status: "pending",
  },
});
await tx.task.update({ data: { status: "running", executionHost: restartAgentHost, agentHost: restartAgentHost } });
```

daemon 收到 `restart_task` 后无条件 spawn 一个新 tmux session：

```
[conductor-daemon] Spawning Fire via tmux: session=conductor-fire-<taskId 前缀>-<nanoid 后缀>
```

后缀（`mpgcjosnt83g` 等）是每次 spawn 时新生成的——架构上**完全没有"找回老 fire"的入口**。

### 间接证据：daemon 内存里的 dedup 表也会卡死 restart

诊断时观察到 daemon log 反复出现：

```
[11:14:50][11:15:01][11:19:22]...[21:28:05] Duplicate restart_task ignored for 6bfb0de7-... (request_id=c0df37cd-...)
```

同一个 request_id 在 10+ 小时里被反复识别为重复——这是 backend 因为没收到 ack 而反复重投、daemon 内存里又有 dedup 表的副作用。如果 8a44 的 restart_task 也踩到这条路径，请求就**永远到不了实际处理逻辑**。

## Goals

- 给被防御性 killed 的 task 一条**不需要 spawn 新 fire** 的恢复路径，复用还活着的 fire。
- 区分"用户显式停止" vs "系统防御性兜底"，只对后者尝试 reclaim。
- 让 restart 在 reclaim 失败时**自动 fallback** 到当前的 spawn 行为，对调用方语义无破坏。
- 把 task 从"假死 → killed → restart 失败循环"中救出来，减少孤儿 fire / 代理 stale binding 累积。
- daemon 唤醒后能更主动地向 backend 报"我手里这些 task 还活着"，从根上减少假死。

## Non-Goals

- 不改变 fire 自身的进程模型、tmux session 命名约定、worktree 隔离方式。
- 不引入跨 daemon / 跨主机 reclaim。
- 不针对 `pty_task` 设计 reclaim；本 RFC 只覆盖 `ai_task`。
- 不替换 watchdog / stale_ws_health 的现有机制；reclaim 是补救，不是预防。
- 不涉及前端 UI 的"失联中"可视化（独立工单跟进）。
- 不修复底层代理 / DNS / 网络的稳定性问题（属基础设施层）。

## Options Considered

### Option A：维持现状，强化用户文档

- Pros：零代码改动。
- Cons：每次睡眠 / 网络抖动都要让用户重启 daemon 才能恢复；老 fire 永远孤儿化；产品体验持续踩坑。

### Option B：restart 时无条件复用任何还连着的 fire

- Pros：实现最简单。
- Cons：无法区分老 fire 是真活着还是僵尸（卡在 RPC、SDK provider hang、tmux 进程残留）；reclaim 错的 fire 会让 task 长时间无响应。**风险大于收益**。

### Option C（推荐）：基于 `killed_reason` + Reclaim 探活的条件性复用

- 引入 `killed_reason` 字段区分死因，只在 `daemon_disconnected` 这一档触发 reclaim。
- spawn 前发一次 `reclaim_task` 探活事件给老 fire；带 ACK 超时。
- ACK 成功 → 老 fire 续命，task.status 直接转 running；ACK 超时 / 失败 → fallback 到现有 `restart_task` spawn 路径。
- Pros：保守、可回退、对现有 happy-path 零侵入。
- Cons：需要协议层 + DB schema 层联动；fire 侧需要实现 reclaim handler；要新增一类 outbox 事件类型。

## Proposed Design

### 1. DB schema：为 `Task` 增加 `killed_reason`

在 `web/prisma/schema.prisma` 的 `Task` 模型里：

```prisma
model Task {
  // ... existing fields
  killedReason  String?  @map("killed_reason")  // enum 字符串
  killedAt      DateTime? @map("killed_at")
}
```

enum 取值（字符串，软枚举，保持向前兼容）：

| 值 | 触发位置 | restart 时是否走 reclaim |
|---|---|---|
| `user_stopped` | 用户点 UI 的 Stop / 调 stop_task API | ❌ 直接 spawn new |
| `daemon_disconnected` | 防御性 reconcile / backend health monitor 判定 daemon 失联 | ✅ **走 reclaim** |
| `fire_exit` | fire 自己 graceful 收尾上报 | ❌ 直接 spawn new |
| `crash` | sdk error / process died | ❌ 直接 spawn new |
| `unknown` | 历史数据迁移 / 未识别 | ❌ 直接 spawn new（保守） |

迁移：所有现有 `status=killed` 的 task `killed_reason` 写为 `unknown`。

### 2. 新增 outbox 事件类型：`reclaim_task`

`web/src/app/api/tasks/[taskId]/restart/route.ts` 的 `isInplaceRestart` 分支改写为（关键片段）：

```ts
const shouldTryReclaim =
  sourceStatus === "killed" &&
  sourceTask.killedReason === "daemon_disconnected" &&
  realtimeHub.getTaskAgentHost(sourceTask.id);

if (shouldTryReclaim) {
  const reclaimAgentHost = realtimeHub.getTaskAgentHost(sourceTask.id)!;
  const reclaimAgent = connectedAgents.find(a => a.host === reclaimAgentHost);
  if (reclaimAgent) {
    // 发 reclaim_task 探活，60s ACK 超时
    await tx.agentOutbox.create({
      data: {
        userId: user.id,
        agentHost: reclaimAgentHost,
        taskId: sourceTask.id,
        eventType: "reclaim_task",
        requestId,
        payloadJson: JSON.stringify({
          type: "reclaim_task",
          payload: {
            task_id: sourceTask.id,
            expected_session_id: sourceSessionId,
            expected_backend_type: sourceBackend,
            ack_timeout_ms: 60_000,
          },
        }),
        status: "pending",
      },
    });
    // 等 ACK；超时 fallback 到现有 restart_task 分支
    const ackResult = await waitForOutboxAck(requestId, 60_000);
    if (ackResult === "acked") {
      await tx.task.update({
        where: { id: sourceTask.id },
        data: {
          status: "running",
          killedReason: null,
          killedAt: null,
          // 注意：不改 agentHost / executionHost，因为 fire 没变
        },
      });
      return NextResponse.json({ mode: "reclaim", source_task_id: sourceTask.id, ... });
    }
    // 超时或 failed → 落入下面的 spawn 路径
  }
}

// === 现有 spawn 新 fire 的 restart_task 逻辑 ===
```

### 3. daemon-side handler

daemon 收到 `reclaim_task` 事件后：

1. 查本地 session store：是否还有这个 task 的活动 fire 子进程。
2. 用 `tmux has-session -t conductor-fire-<taskId 前缀>-*` 探测 tmux session 是否还在。
3. 通过 IPC（已有的 fire ↔ daemon channel）给 fire 发 `reclaim_probe { task_id, expected_session_id, expected_backend_type }`。
4. 在 `ack_timeout_ms` 内收到 fire 的 `reclaim_ack { status: "alive" | "stale" | "wrong_session" }`：
   - `alive` → 给 backend 回 `reclaim_task` 的 acked，并把 fire 标记为重新可接收消息。
   - 其它 → 给 backend 回 `reclaim_task` 的 failed，附 reason。
5. 超时也回 failed。

### 4. fire-side handler

`modules/conductor-sdk` 或 `cli/` 里 fire 进程的事件循环增加 `reclaim_probe` 处理：

1. 比对 `expected_session_id` 是否等于本进程实际持有的 `sessionId`；不等 → `wrong_session`。
2. 比对 `expected_backend_type` 是否等于本进程的 backend；不等 → `wrong_session`。
3. 检查 SDK worker（如 `ai-sdk/dist/worker.js`）的健康度：最近 N 秒内有过心跳 / 不在长时间 hang 的 provider 调用里 → `alive`，否则 `stale`。
4. 回 `reclaim_ack`。`alive` 时**重置自己的 idle timer**，准备接收下一条 user message。

### 5. 反向增强：daemon 唤醒后主动上报存活 task

`daemon log` 已经有：

```
Reconciled tasks after reconnect: backendAssigned=0 localActive=11 markedKilled=0
```

把 `localActive=N` 这条扩展成主动 push：daemon 在每次 `Connected to backend` 之后发一条 `agent_alive_tasks { agent_host, alive_task_ids: [...] }` 给 backend。backend 收到后：

- 对每个 task：若 DB 中 `status=killed AND killed_reason=daemon_disconnected` → **直接撤销 killed 标记，转回 running**，不需要用户点 restart。
- 若 DB 中 `status=running` 且绑定一致 → 维持现状。
- 若 DB 中 `status=killed AND killed_reason=user_stopped` → 不撤销，并通知 daemon 把 fire 杀了（用户意图优先）。

这条比 reclaim 路径更治本——**根本不让 daemon 失联引起的 task 进入需要 restart 的状态**。

### 6. 调用约束 & 边界

- `reclaim_task` 不允许跨 host：必须等于 `realtimeHub.getTaskAgentHost(sourceTask.id)` 返回的当前绑定。
- `reclaim_task` 不能改 backend：跨 backend restart 走 `new_task` 分支，与本 RFC 无关。
- `agent_alive_tasks` push 仅当 daemon 是 `daemon` 角色（不是 manual fire host）时才发送。
- reclaim 成功后，原 task 的 `restartedAt` / `restartCount` 等指标**不递增**——本质上 task 没死过。

## Risks

- **Fire 误判 alive 但实际 hang**：reclaim_ack 回了 alive，但后续 user message 仍然超时。
  - 缓解：fire 的 alive 判定要参考 SDK worker 最近心跳，不能只看进程存活。worker.js 自身已有 heartbeat 机制。
- **agent_alive_tasks 撤销 killed 状态的并发问题**：用户在 daemon 上报 alive 的同时点了 restart。
  - 缓解：撤销 killed 时用乐观锁（task.updated_at 作为 version），失败就放弃撤销，让用户的 restart 走流程。
- **`killed_reason=daemon_disconnected` 误标**：health monitor 把 user_stopped 错标成 disconnected。
  - 缓解：先用现有显式 stop API 写 user_stopped；其它路径默认 daemon_disconnected；逐步收敛。
- **老 fire 的 backend ws 也是半死的**：reclaim 成功后还是不能干活。
  - 缓解：fire-side 在回 alive 之前，主动 probe 自己的 ws（发一条 ping，等 pong）。本 RFC 范围内覆盖。
- **协议向后兼容**：旧版 daemon 不认 `reclaim_task` 事件类型。
  - 缓解：daemon 收到未知事件类型时回一个 `unsupported_event_type`；web server 看到这种回执时退化为旧的 restart_task 路径。

## Rollout

### 阶段 1：DB 字段 + spawn 路径不变（无行为变化）

- 加 `Task.killedReason` / `Task.killedAt` 字段，migration 把存量数据补 `unknown`。
- 在所有标 killed 的入口写入正确的 `killedReason`：
  - `web/src/app/api/tasks/[taskId]/stop/route.ts` → `user_stopped`
  - daemon reconcile 时 markedKilled 路径 → `daemon_disconnected`
  - fire graceful exit 上报 → `fire_exit`
  - crash handler → `crash`
- 此阶段对外无行为变化。

### 阶段 2：reclaim 探活路径，feature flag 控制

- 加 env `CONDUCTOR_TASK_RECLAIM_ENABLED=false` 默认关闭。
- 实现 web `reclaim_task` 写 outbox + 等 ack。
- 实现 daemon `reclaim_task` handler。
- 实现 fire `reclaim_probe` handler。
- 内部 dogfood：在 dev daemon (`./bin/conductor-dev`) 上开 flag 跑一周。

### 阶段 3：daemon 主动上报 alive

- 实现 `agent_alive_tasks` push（daemon → backend），ack 回执。
- backend 实现"撤销 daemon_disconnected killed"路径。
- 灰度按 user_id 哈希开 5%。

### 阶段 4：全量

- flag 默认 true，老协议保留至少 1 个 release 周期。

### 向后兼容

- 旧版 web server + 新版 daemon：daemon 收不到 reclaim_task，无差别；新协议是 superset。
- 新版 web server + 旧版 daemon：reclaim_task 超时 → 自动 fallback restart_task → 行为等价于旧版。

## Acceptance

实现完成的判定标准：

1. **集成测试 1**：模拟 daemon 失联（kill -STOP daemon 30s 后 kill -CONT），fire 仍在 tmux 里。点 restart 后：
   - `restart` 接口返回 `{ mode: "reclaim", ... }`。
   - task.status 从 killed 直接回到 running，无新 tmux session spawn。
   - 老 fire 收到下一条 user message 并正常回复。
2. **集成测试 2**：用户显式点 Stop，再点 Restart：
   - killed_reason 写为 user_stopped。
   - restart 走 spawn 新 fire 路径，**不** reclaim。
3. **集成测试 3**：daemon 唤醒后主动上报 alive_tasks：
   - 一个 killed_reason=daemon_disconnected 的 task **不用 restart 就自动回 running**。
4. **协议向后兼容测试**：旧版 daemon 配新版 web server，restart 行为等价旧版（reclaim 超时 fallback）。
5. **观测指标**：上线一周后，task 标 killed 后 1 小时内被 restart 的次数下降 ≥ 60%（这是失联睡眠场景的主要复发率）。

## Open Questions

1. `agent_alive_tasks` 的 push 频率：唤醒后一次 OK 吗？还是每次 `Connected to backend` 都 push？后者更安全但可能放大 backend 负载。
2. fire 自己判 alive 时，SDK worker 的心跳源在 ai-sdk 包内部还是 fire CLI 层？需要确认现有 worker 是否已经在 fire 进程主线程能看到的位置写心跳。
3. reclaim 失败后立即 fallback spawn 时，新 fire 起来会和老 fire 在 hub 上同时存在一段时间，UI 显示要不要做去重？
4. `killed_reason=daemon_disconnected` 的撤销路径要不要也允许 fire 自己上报"我还活着"（fire → backend 直接走，不经 daemon）？这能进一步缩短失联恢复时间，但和 daemon 的 single source of truth 原则有冲突。
5. 跨用户场景：如果同一台 m1 上跑了 user A 和 user B 的 task，daemon 上报 alive_tasks 时如何隔离权限？现有 outbox 已有 `userId` 字段，按这个隔离即可，但要确认 reclaim 路径全程也带 userId。
