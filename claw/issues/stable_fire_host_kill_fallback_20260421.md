# Kill task fails when fire host is disconnected

## Symptom

线上 kill 任务 `f93e396c-cc2f-41e5-bbdd-2f5ce5da0880` 失败，daemon 日志：

```
[conductor-daemon 2026-04-21T22:08:28] Task f93e396c-cc2f-41e5-bbdd-2f5ce5da0880 finished with code 0
[conductor-daemon 2026-04-21T22:08:28] Logs: /Users/bytedance/ws/dang-where-to-go/.conductor/worktrees/f93e396c-cc2f-41e5-bbdd-2f5ce5da0880/conductor.log
[conductor-daemon 2026-04-21T22:08:28] Backend error: Task f93e396c-cc2f-41e5-bbdd-2f5ce5da0880 is assigned to conductor-fire-unknown-host-45775, not m2
```

## Root Cause Analysis

三个关联问题：

### 1. Stop 命令始终发给已断连的 fire host

`resolveTaskStopTargetHost` 直接返回 `executionHost`（fire host），不检查它是否在线。fire 进程退出后 stop 命令无法送达，kill 回滚或超时。

**相关代码**: `web/src/lib/tasks/task-stop.ts` L47-64, `web/src/app/api/tasks/[taskId]/route.ts` L472-478

### 2. Daemon 与 fire host 争抢 RUNNING 状态（race condition）

Daemon spawn fire 子进程后立即发 `task_status_update(RUNNING)`（`cli/src/daemon.js` L4348），与 fire host 的 `executionHost` claim 产生竞争。如果 fire host 先 claim 成功，daemon 的 RUNNING 更新触发 ownership check 失败，产生 "is assigned to" 错误。

**相关代码**: `cli/src/daemon.js` L4340-4359 (create_task), L4765-4784 (restart_task)

### 3. Daemon 收到 stop 后不上报终态

Daemon 的 exit handler 检查 `managedByFireBridge === true` 就跳过状态上报（`shouldDaemonReportFireChildTerminalStatus` 返回 false）。即使 backend 把 stop 转发给 daemon，daemon 也不会告知结果，导致任务永远卡在 killing。

**相关代码**: `cli/src/daemon.js` L3839-3841, L4415

## Proposed Fix (待后续观察确认后实施)

### Server side (`web/src/app/api/tasks/[taskId]/route.ts`)

PATCH handler 中 resolve `stopTargetHost` 后，检查 fire host 是否在线（`realtimeHub.hasAgentHost`）。若已断连，回退到原始 daemon（`existing.agentHost`）。由于 `nextExecutionHost = stopTargetHost`，DB 会自动把 `executionHost` 更新为 daemon，后续 ownership check 自然通过。

```typescript
if (
  shouldStopTask &&
  stopTargetHost &&
  isConductorFireHost(stopTargetHost) &&
  !realtimeHub.hasAgentHost(stopTargetHost, user.id)
) {
  const daemonHost = normalizeOptionalString(existing.agentHost);
  if (daemonHost && !isConductorFireHost(daemonHost)) {
    stopTargetHost = daemonHost;
  }
}
```

### Daemon side (`cli/src/daemon.js`)

- 移除 fire-managed task 的 RUNNING 状态上报（create_task 和 restart_task 两处），由 fire host 连接后自行上报
- `handleStopTask` 中收到 fire-managed task 的 stop 命令时，重置 `managedByFireBridge = false`，让 exit handler 正常上报终态

```javascript
// handleStopTask 中，stopActiveTaskProcess 之前：
if (processRecord && processRecord.managedByFireBridge) {
  processRecord.managedByFireBridge = false;
}
```

## Status

继续观察，确认复现频率后再修复。
