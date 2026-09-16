# UI Bug: Graph View Toggle Not Synced Across Merged Daemon Projects

## Symptom

同一个仓库分别 checkout 在两台 daemon 上时，项目列表会把两个 `Project` 行合并成一张卡片。
在这个合并项目的详情弹窗（双击项目卡片）里操作 **Task view → Graph view** 开关：

- 打开后切到另一个 daemon 的 tab，开关看起来**自己弹回了关闭**；
- 更严重的是**关不掉**：只要另一个成员之前开过，点关闭后侧边栏 / 任务页仍然停留在 graph view。

## Root Cause

**写入的成员范围和读取的成员范围不一致。**

写入只作用于当前 tab 对应的那一个成员（`ProjectDetailsDialog.tsx`）：

```ts
await updateProject(latestProject.id, {            // 只写 activeProject
  metadata: buildMetadataWithTaskGraphEnabled(latestProject, nextEnabled),
});
```

但所有读取方都是对**整个合并组**取并集：

- `Sidebar.tsx` / `MobileNav.tsx`：`members.some((project) => isProjectTaskGraphEnabled(project))`
- `app/tasks/page.tsx`：`projects.some((project) => scopedProjectIds.has(project.id) && isProjectTaskGraphEnabled(project))`

所以：

1. 开关本身只显示 `activeProject` 的值（`isProjectTaskGraphEnabled(activeProject)`），切 tab 就换成另一个成员的值 → "弹回去"；
2. 关闭时只把一个成员写成 `false`，另一个成员还是 `true`，`.some(...)` 依然为真 → "关不掉"；
3. 另外还有一个 `useEffect(() => setPendingTaskGraphEnabled(null), [activeProject.id])`，切 tab 时主动清掉乐观值，放大了第 1 点。

## Fix

让写入和读取覆盖**同一组成员**：

- **读**：开关显示 `detailProjects.some(isProjectTaskGraphEnabled)`，和所有读取方的语义一致；删除切 tab 时重置乐观值的 effect。
- **写**：新增 store action `updateProjectGroupMetadata(projectIds, buildMetadata)`，扇出到合并组的每个成员。
  - 每个成员用**它自己最新的快照**构造 payload（`metadata` 是整块 PATCH，不能用一份预先算好的 payload 覆盖所有成员，否则会冲掉别的成员上的 memo 等 key）；
  - 传入的 id 会经 `expandMergedProjectGroup` 扩展到**完整合并组，包括隐藏（归档）成员**。项目列表只对可见项目分组，弹窗拿到的成员可能不全；
  - 部分成员写入失败时抛出 `Saved on X of Y daemons: ...`，不吞错。
- 写入成功后释放乐观值，交回 store 作为唯一数据源。

修改文件：

- `web/src/features/projects/components/ProjectDetailsDialog.tsx`
- `web/src/features/projects/store.ts`（`updateProjectGroupMetadata`）
- `web/src/features/projects/utils/project-groups.ts`（`expandMergedProjectGroup`）

## Test

- `ProjectDetailsDialog.test.tsx` 新增 `graph view across a merged project group`：全组开启、全组关闭、只有兄弟成员开启时开关显示 on、切 tab 后状态不变、扇出时保留各成员自己的 metadata。**把修复回退后其中 4 条失败**，确认回归测试有效。
- `store.test.ts`：扇出覆盖隐藏成员、每个成员用自己的快照、部分失败会上报。
- `project-groups.test.ts`：`expandMergedProjectGroup` 包含隐藏成员、排除不可合并的项目。

## How to Avoid Next Time

1. **一个设置如果描述的是"项目"而不是"某台机器上的 checkout"，读和写必须覆盖同一组成员。** 改写入范围前，先 `rg` 一遍所有读取方用的是单成员还是 `.some(...)` / 并集。
2. 合并组的跨成员写入统一走 `updateProjectGroupMetadata`，不要在组件里各自挑 `activeProject` 写。
3. "可见成员"和"全部成员"是两个不同的集合。并集读取包含隐藏成员时，写入也必须包含，否则隐藏成员上的旧值会"复活"。
   同一类问题在开发 task label 时又出现了一次（设置页只删了可见成员，任务卡片却对全部成员取并集，导致删掉的 label 又出现），在 review 阶段被发现并用同一个 `expandMergedProjectGroup` 修复。
