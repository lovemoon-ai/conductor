# UI Bug: Running Fire Task "New task from this" Button Disabled

## Symptom

在移动端任务列表左滑后，"New task from this" 按钮处于禁用状态（灰色不可点击）。该任务是一个 AI Task，状态为 running，agent_host 为 `conductor-fire-unknown-host-*`（Fire task），且对应的原始 daemon 在线。

## Root Cause

代码对 Fire task 的状态限制过于严格，没有区分两种 restart 策略：

1. **In-place restart**（原地重启）：需要复用原任务的 session，因此要求任务必须处于 stopped 状态（completed/killed/unknown）
2. **New task from this**（创建新任务）：从原任务 fork 状态创建新任务，不需要原任务停止

原来的代码在 **RestartTaskControls.tsx:118** 和 **route.ts:155** 阻止了所有 running 状态的 Fire task，即使是 "New task from this" 操作。

## Fix

### 1. 前端修复 (RestartTaskControls.tsx)

修改 `disabledReason` 逻辑，允许 running Fire task 在选择不同 backend（即 new_task 策略）时可用：

```tsx
// Before
if (isManualFireTask && !STOPPED_TASK_STATUSES.has(task.status)) {
  return 'Manual fire tasks can only restart after they stop';
}

// After  
const canDoInplaceRestart =
  task.status === 'completed' || task.status === 'killed' || task.status === 'unknown';
if (isManualFireTask && !canDoInplaceRestart && currentBackend === selectedBackend) {
  return 'Manual fire tasks can only in-place restart after they stop; switch backend to create a new task';
}
```

### 2. 后端修复 (route.ts)

修改 API 逻辑，区分 inplace 和 new_task 策略的限制：

```ts
// Before
if (isManualFireTask && !STOPPED_TASK_STATUSES.has(sourceStatus as any)) {
  return NextResponse.json(
    { error: "manual fire task can only restart after it has stopped" },
    { status: 409 },
  );
}

// After
const canDoInplaceRestart = STOPPED_TASK_STATUSES.has(sourceStatus as any);
const isExplicitInplaceRequest = requestedStrategy === "inplace" ||
  (!requestedStrategy && canDoInplaceRestart && targetBackend === sourceBackend);
if (isManualFireTask && isExplicitInplaceRequest && !canDoInplaceRestart) {
  return NextResponse.json(
    { error: "manual fire task can only in-place restart after it has stopped" },
    { status: 409 },
  );
}
```

### 3. 测试更新

- 修改原有测试：将 "returns 409 when a conductor-fire task is still running" 改为验证允许 new_task 策略
- 新增测试：验证 running Fire task 使用 inplace 策略时仍然返回 409

## How to Avoid

1. **区分策略限制**：在设计 restart 功能时，明确区分 inplace 和 new_task 两种策略的前提条件
2. **移动端提示**：对于移动端用户，考虑直接在按钮下方显示禁用原因，而不是依赖 hover tooltip
3. **测试覆盖**：为不同策略、不同状态组合添加完整的测试用例

## Files Changed

- `web/src/components/conductor/tasks/RestartTaskControls.tsx`
- `web/src/app/api/tasks/[taskId]/restart/route.ts`
- `web/src/__tests__/api/tasks-restart-route.test.ts`

## Verification

```bash
cd web && pnpm test -- --run
# 73 test files passed, 413 tests passed
```
