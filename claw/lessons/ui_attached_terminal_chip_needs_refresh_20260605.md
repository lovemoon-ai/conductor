# UI Bug: PTY Chip Doesn't Appear / Disappear Until Manual Refresh

## Symptom

附加终端创建（POST `/api/tasks/:id/terminal`）成功后，AI task 列表/卡片上不会立刻显示 `pty` 角标，必须手动刷新一次页面才能看到。删除附加终端时同样：chip 残留到下次刷新。

## Root Cause

`TaskItem.handleAttachTerminal` 与 `PtyToggleButton.performDelete` 在 mutation 后都调用：

```ts
await fetchTasks(undefined, { recoverStale: false }).catch(() => {});
```

但 `/app/tasks` 页面的 useEffect 会根据 URL 的 `projectId` 调用 `setProjectFilter`，
让 `useTasksStore.currentProjectFilter` 等于 `proj-xxx`。`fetchTasks` 内部有这段竞态守卫：

```ts
const requestedProjectId = projectId ?? null; // null
if (
  get().currentProjectFilter !== requestedProjectId    // "proj-xxx" !== null
  || get().currentProjectIds.length !== 0
  || requestId !== fetchTasksRequestSequence
) {
  tasksPromise.catch(() => {});
  return; // 直接丢弃响应
}
```

所以**只要用户在某个具体项目视图下**（也就是 99% 的实际使用场景），mutation 后的全量
refetch 会被丢掉，store 里那条 AI task 的 `attachedTerminal` 字段也就永远停留在旧值，
UI 也就看不到 `pty` 角标的出现/消失。

这条守卫本身没问题——它防止"切换项目时旧响应覆盖新视图"，问题在于调用方传错了 scope。

## Fix

把"刷新整张列表"换成"刷新当前这条 AI task"：

```diff
-      await fetchTasks(undefined, { recoverStale: false }).catch(() => {});
+      await fetchTask(task.id).catch(() => {});
```

`fetchTask(taskId)` 走 `syncTask` → `upsertTask`，直接按 id 替换 store 里那条记录，
跟 `currentProjectFilter` 没有任何关系；并且单任务 GET `/api/tasks/:id` 在 `route.ts`
里通过 `loadAttachedTerminalSummary` 已经把 `attachedTerminal` 一并返回，所以新增 / 清除
都能在一个 round-trip 内反映到 UI。

修改文件：

- `web/src/features/tasks/components/TaskItem.tsx`（attach handler）
- `web/src/features/tasks/components/PtyToggleButton.tsx`（delete handler）

## Test

`web/src/features/tasks/store.test.ts` 新增一条回归用例：在 `currentProjectFilter='proj-1'`
状态下调用 `fetchTask('task-ai-1')`，期望 `attachedTerminal` 被正确写回，且
`currentProjectFilter` 保持不变。

## How to Avoid

1. **mutation 后的 refresh 要用最窄 scope**。优先级：
   1. 用 API 响应直接 patch store（不需要 round-trip 的就别 round-trip）
   2. `fetchTask(id)` 单条刷新
   3. `fetchTasks(projectId, ...)` 全列表刷新——这条**必须带着当前 currentProjectFilter**，
      不能裸传 `undefined`
2. **看到 `fetchTasks(undefined, ...)` 警觉**：除非确认当前一定不在任何项目过滤态，否则
   它的响应大概率会被竞态守卫丢掉。同一仓库里 `fetchTasksForProjects` 类似——空数组会
   fallback 到 `fetchTasks(undefined)`，同样有这个坑。
3. **`fetchTasks` 的早期 bail-out 现在静默吞掉 promise**（`tasksPromise.catch(() => {})`
   后 `return`），调用方不会拿到 reject。这让"为什么 UI 没更新"很难 debug——以后给
   `fetchTasks` 加一条 `console.warn`（dev 模式）或返回一个表示"被守卫丢弃"的状态，
   能更早暴露类似 bug。

## Verification

```bash
cd web && ./node_modules/.bin/vitest run
# Test Files  145 passed (145), Tests  1229 passed (1229)
```
