# ui: 项目卡拖到另一张卡中央只重排、不生成聚合分组 (BUG-R5-03)

## 症状
在 Projects 页把一张项目卡拖到另一张卡的**中央**，期望生成聚合分组（两张卡合并为一个带 tab 的分组卡），实际只发生重排（reorder），从不聚合，也没有任何 `project-card-groups` 偏好写入。任务卡（TaskList）的同类"拖到中央聚合"却工作正常。

## 根因
`ProjectList.tsx` 的分组判定（handleDragOver 的 middle-band 检测）用的是 **dnd-kit 的 `event.active.rect.current.translated`**（被拖卡自身的变换后包围盒）对比 `event.over.rect`，且外层是 `verticalListSortingStrategy` 的 `SortableContext`。该 strategy 在卡片一被 hover 时就立刻位移目标卡以让出重排间隙，导致被拖卡的中心永远无法稳定落在目标卡的 0.32–0.68 中央带里 → `aggregateTargetKey` 几乎从不被 set → `handleDragEnd` 里 `aggregateTargetKey === overId` 恒不成立 → 每次都落到 reorder 分支。

单测 `ProjectList.aggregate.test.tsx` 用合成的 `translated` 几何**手喂**中央带命中，掩盖了这个在真实浏览器里不可达的路径。

对比：任务卡 `TaskList.tsx` 不用 dnd-kit，而是用**实时指针位置 vs 每行实时 `getBoundingClientRect()`**（`findRowIdAtPoint`）判定，所以聚合稳定可靠。

## 修复
让分组判定改用**实时指针位置对比目标行的稳定布局矩形**，而非被拖卡的变换盒：
1. 新增 `readDragPointerY(event)`：从 `activatorEvent.clientY`（或 touch）+ 累积 `delta.y` 还原实时指针 Y。
2. 为每个渲染行的**外层 wrapper div** 挂 `ref={setRowRef(key)}`（wrapper 不是 dnd-kit 的 sortable 节点，其 rect 是稳定布局槽，不受 transform 干扰）。
3. `handleDragOver` 里改成 `ratio = (pointerY - targetRect.top) / targetRect.height`，落在中央带才 `setAggregateTargetKey`。
4. 修正被掩盖的单测：改喂真实指针坐标（`activatorEvent.clientY` + `delta`）并 stub wrapper 的 `getBoundingClientRect`，让测试真正走指针几何。

## 如何避免
- **拖拽命中判定优先用实时指针 + 目标实时 rect，不要用被 sortable strategy 位移的被拖元素变换盒。** 只要外层是 `verticalListSortingStrategy` 之类会位移目标的策略，基于被拖盒的中央带判定就不可靠。
- 已有可靠实现（TaskList 的 `findRowIdAtPoint`）应作为同类交互的参考模板，避免两套发散实现。
- **警惕"喂合成几何"的单测**：它会让永不触发的分支在测试里绿灯。拖拽类测试应尽量喂真实指针坐标 + 真实/stub 的 rect，覆盖真实几何路径。
- Code review 时，凡新增 `ref` 回调（如 `setRowRef`）务必确认它**真的挂到了 JSX 元素上**——本次初版修复就漏挂了 wrapper 的 `ref`，导致 `rowRefs` 恒空、修复形同虚设，被 review 拦下。
