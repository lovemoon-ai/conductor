# ui: 项目卡拖到另一张卡中央只重排、不生成聚合分组 (BUG-R5-03)

## 症状
在 Projects 页把一张项目卡拖到另一张卡的**中央**，期望生成聚合分组（两张卡合并为一个带 tab 的分组卡），实际只发生重排（reorder），从不聚合，也没有任何 `project-card-groups` 偏好写入。任务卡（TaskList）的同类"拖到中央聚合"却工作正常。

## 根因
最初实现用 dnd-kit 的被拖卡变换盒与 `event.over.rect` 判断中央带。`verticalListSortingStrategy` 会在进入目标卡时立刻位移卡片，这让中央带路径在真实浏览器里几乎不可达。

第一次修复虽然改成了“实时指针 + 外层稳定 wrapper rect”，但仍有三个相互叠加的问题：

1. 指针刚进入目标卡外沿时就更新 `dragOrderKeys`，React 立即重排 DOM，目标 wrapper 在指针到达中央前已经移走。
2. 中央带判断挂在 `onDragOver`；该回调只在 dnd-kit 的 collision target 改变时触发，指针在同一张卡内从外沿移动到中央并不会再次触发。
3. `verticalListSortingStrategy` 仍会移动可见目标卡，稳定 wrapper 的布局槽和用户看到的卡片位置不一致。

因此真实拖放仍只进入 reorder 分支。旧聚合单测直接合成一次中央 `onDragOver`，没有覆盖“先跨过外沿、再进入中央”的真实指针轨迹，继续掩盖了问题。

## 修复
1. 拖动期间保持列表 DOM 顺序不变，只在 `onDragEnd` 提交最终 reorder。
2. 将中央带判断改到每次指针移动都会触发的 `onDragMove`。
3. 从 activator 坐标与累计 delta 还原实时 X/Y，并遍历外层 row refs 做稳定的二维命中测试。
4. 使用不产生 sortable transform 的 strategy，让可见卡片和用于命中测试的布局槽保持一致；拖动反馈仍由 `DragOverlay` 提供。
5. 释放时用最终指针坐标重新计算目标与中央带，不依赖可能陈旧的 React highlight state 或 dnd-kit `event.over`。
6. 回归测试模拟“先跨目标卡外沿，再进入中央并释放”，并验证拖动期间 DOM 顺序稳定、中央释放保存分组且不调用 reorder。

## 如何避免
- 中央/边沿这种连续区域判断必须使用逐次移动事件；`onDragOver` 适合监听 collision target 变化，不适合监听同一目标内部的位置变化。
- 不要在依赖某张卡作为命中面时先移动它。若拖动中需要重排预览，应另建稳定的命中层，而不是复用正在 transform 的可见卡。
- 释放时重新命中最终坐标，避免最后一次快速移动落到陈旧目标。
- **拖拽命中判定优先用实时指针 + 目标实时 rect，不要用被 sortable strategy 位移的被拖元素变换盒。**
- 已有可靠实现（TaskList 的 `findRowIdAtPoint`）应作为同类交互的参考模板，避免两套发散实现。
- **警惕“直接喂最终几何”的单测**：拖拽测试必须覆盖进入目标外沿、移动到中央、最终释放的完整轨迹。
- Code review 时，凡新增 `ref` 回调（如 `setRowRef`）务必确认它**真的挂到了 JSX 元素上**——本次初版修复就漏挂了 wrapper 的 `ref`，导致 `rowRefs` 恒空、修复形同虚设，被 review 拦下。
