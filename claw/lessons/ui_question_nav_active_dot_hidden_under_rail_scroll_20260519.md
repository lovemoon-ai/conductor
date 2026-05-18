# 长聊天下，QuestionNav 当前激活的圆点被自身 scrollbar 隐藏

## 症状
在 task 详情聊天页（ChatView），右侧的"用户问题快速跳转导航"（`QuestionNav`）给每条用户消息渲染一个圆点。当聊天非常长、圆点数量很多时，导航容器自身（`max-h-[80%] overflow-y-auto`）会出现纵向 scrollbar。用户在主聊天区滚动时，"当前激活"的那个圆点经常落在导航容器自身可视区**之外**，必须手动去滚右侧导航才能看到它——视觉上等于丢失了"我此刻在聊天里的位置"这一信息。

## 根因
`QuestionNav` 早就具备两个能让 bug 不发生的条件：
- 容器有 `overflow-y-auto`，浏览器愿意在容器内部滚动；
- `ChatView` 通过 rAF 监听主区域滚动，正确地维护着 `activeQuestion`，并把它作为 `activeIndex` 透传给 `QuestionNav`。

但**没有任何代码**把"`activeIndex` 改变"和"把对应圆点滚进导航容器自身可视区"这两件事连起来。结果是：active 状态算对了、大圆点也渲染对了，可它在用户眼里是看不见的——它躺在导航容器自身 scroll 区域外面。

`handleJumpToQuestion`（点击圆点跳转那条路径）也有同样问题：它会把主聊天区滚到目标消息，并 `setActiveQuestion(questionIndex)`，但同样没人把右侧导航滚到对应圆点。

## 修复
只动一个文件 `web/src/components/common/QuestionNav.tsx`：

1. 给每个圆点 `<button>` 加 callback ref，统一存进 `buttonRefs: Map<number, HTMLButtonElement>`（卸载时自动清理）。
2. 加一个 `useEffect`，依赖 `[activeIndex, visible, count]`：在导航可见时调用激活圆点的 `scrollIntoView({ block: 'nearest', inline: 'nearest' })`。

为什么用 `block: 'nearest'` 而不是 `'center'`/`'start'`：
- 浏览器只在"目标真的不在容器视口内"时才滚动，已经可见就什么都不做；
- 用户滑动聊天经过每条用户消息时，右侧导航不会被一遍遍甩到中央造成抖动；
- 完全契合需求："保持当前激活节点在视图内即可，不用拉到中间"。

为什么 `!visible` 时直接 return：
- 导航在 `opacity-0 / pointer-events-none` 状态本来就看不见，滚它毫无意义；
- 更重要的是，对一个不可见、可能尺寸坍缩的元素调 `scrollIntoView` 有概率干扰祖先滚动容器（把主聊天区误滚动）。当导航重新 visible，effect 会因为 `visible` 进入依赖而再次触发，自动 re-sync 到当前 active 圆点——既安全又顺手。

`ChatView.tsx` 不需要改：用户主区域滚动产生的 `setActiveQuestion`、和点击圆点跳转产生的 `setActiveQuestion`，最终都体现在 `activeIndex` 上，effect 一处覆盖两条路径。

新增测试 `web/src/components/common/QuestionNav.test.tsx`（3 个用例）：
- `activeIndex` 改变时，调用栈来自正确的圆点 button，参数为 `{ block: 'nearest', inline: 'nearest' }`；
- `visible=false` 期间不滚动，`visible` 回到 true 时立即 re-sync；
- `count === 0` 既不渲染也不滚动。

## 下次怎么避免
1. **"可滚动容器 + 选中态"是一个组合体**：只要一个组件里同时存在「内部 scroll」和「当前激活/选中项」，就必须显式回答"激活项不在视口内时由谁来把它滚进来"。否则容器越长，用户越容易看不到激活项。这类组件做完后，最好用一个"100 项 + 中间激活"的极端用例自测一遍。
2. **`scrollIntoView` 默认要选 `block: 'nearest'`**：除非有强需求把项目拉到中央，`'nearest'` 几乎总是更优——它"按需最小幅度滚动"，不会在用户主动滚动时反复抢镜。把"是否需要 center"明确成一道刻意的选择题，而不是默认值。
3. **隐藏元素上别调用 `scrollIntoView`**：opacity-0 / display 收起 / `aria-hidden` 状态下的元素调 `scrollIntoView` 可能引起祖先滚动容器跳动。先 `if (!visible) return`，把它降级成"重新显示时再 sync"。
