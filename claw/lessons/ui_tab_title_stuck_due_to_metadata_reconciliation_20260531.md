# Symptom

- `/app/tasks?projectId=…` 上明明侧边栏已经选中某个真实 project（如 "Default project"），但浏览器 tab title 一直停在 `"Conductor"`，不显示项目名。
- 其它 in-app 页（`/app/projects`、`/app/issues`、`/app/settings`）表现正常，所以一开始很容易误以为"只有 tasks 有 bug"。
- 拖了 8+ 轮才定位 —— 大多数轮次都用来在错误的方向上微调代码（store vs URL 优先级、是否用 task.projectId、是否带 `useSearchParams` fallback……）。

# Root Cause

## 技术原因
1. 根 layout (`src/app/layout.tsx`) 的 `metadata.title = "Conductor"` 在 Next.js App Router 里会被渲染成 `<title>Conductor</title>` 注入到 `<head>`。**每次 React commit 都会 reconcile 这个 head element**，等于反复给 `document.title` 写回 `"Conductor"`。
2. `ProjectDocumentTitle` 用的是 `useEffect(() => {…}, [pathname, projects, selectedProjectId, urlProjectId])` —— **只有 deps 变了才重跑**。
3. tasks 页面是个 polling-heavy 的"活页面"：tasks polling、websocket 事件、`useSyncExternalStore`（桌面媒体查询）、`replaceTaskRoute` 改 URL、selected-task 状态切换……每秒触发若干次 layout 子树 re-render，但这些 re-render 都不改我那 4 个 deps。结果：Next reconcile 写回 `"Conductor"` → 我的 effect 不重跑 → title 永远卡在 `"Conductor"`。
4. projects/issues/settings 三个页面相对"安静"，commit 频次低，所以同一份代码在它们身上看不到这个问题，造成"只有 tasks 坏了"的假象。

## 过程原因
- 误读了第二轮的需求："task 页面也是显示 project name" 被理解成"task 页面要特殊处理（用 task.projectId）"，其实用户的意思就是"task 页面也跟其它页面一样（用 sidebar selectedProjectId）"。
- 从来没把 app 真正跑起来看一眼。CLAUDE.md 明确写了 `make run-dev` + chrome-devtools MCP 的 E2E 流程，但前 7-8 轮全是在代码里推理。
- 每轮拿"unit test 通过"当结论，但那些 test 只验证了脑子里的模型（mock 静态值、render 一次），完全没测"频繁 re-render 时 title 会不会被外部冲掉"这种反向场景。
- 太相信第一个 Explore agent 的"没有其他写 `document.title` 的地方"结论。文本搜索搜不到框架级行为（Next.js metadata reconciliation）。
- 用户重复提示"对比四个页面"三次都没换思路，每次都在错误的轴上找差异（URL ↔ store 时序），直到第三次才意识到真正的差异是 **render 频次**。

# Fix

- `web/src/components/layout/ProjectDocumentTitle.tsx`：
  - `useEffect` → `useLayoutEffect`（commit 之后、paint 之前同步盖回 title）。
  - **不带 dep array** —— 每次 render 都重跑（加 `eslint-disable-next-line react-hooks/exhaustive-deps` 并在 JSDoc 注释里写明原因）。
  - Next reconcile 一次 `<title>Conductor</title>`，我立刻盖回项目名，浏览器 paint 时看到的就是项目名。
  - 字符串赋值开销可以忽略，组件本身 `return null` 不参与 DOM 协调。
- title 解析顺序最终落在：URL `?projectId=` → store `selectedProjectId` → `"Conductor"`，每个候选都独立去 `projects.find()`，避免 truthy-but-unresolvable 的 id（localStorage 残留）把后面的有效候选短路掉。
- 加 regression test：模拟两次 render 之间 `document.title` 被外部改回 `"Conductor"`（= Next.js metadata reconciliation），不改任何 props/store，rerender 后必须重新变回项目名。

# How To Avoid Next Time

## 技术
1. **写 `document.title` / 改 `<head>` 的客户端逻辑，必须假设 Next.js App Router 的 metadata 系统会在 commit 时反向覆盖**。如果是动态值，不要用 dep-gated `useEffect`，用 `useLayoutEffect` + 不带 deps 是最稳的兜底。
2. **单元测试要能证伪假设**，不止"初次 render 设置正确"。必须包含外部干扰、frequent re-render、并发更新这类反向场景。否则测试只是把你脑子里的模型 echo 出来。
3. **涉及 `<head>` 或全局副作用的可视化变化，永远不要假设"跑一次就留住了"**。要么写在每次 render 都跑的同步 effect 里，要么用 framework 提供的 reactive metadata API，要么用 MutationObserver。

## 过程 / 心法
1. **用户说"不对" → 先把实物跑起来，再改代码**。CLAUDE.md 里的 E2E 流程不是摆设。这次跑一次应该能 1-2 轮定位，结果代码里推理拖了 8 轮还在错的方向上。
2. **需求模糊先 `AskUserQuestion`**。不要按"最大化解读"硬上。"也是 X" 通常意思是"和其它一样 X"，不是"在 X 上做特殊化"。误读会导致后面连串震荡（task-aware 加 → 撤 → 加 → 撤）。
3. **同一个提问/提示从用户口里出现两次以上，立刻换轨**。用户重复说"对比四个页面"，说明前一次分析方向错了，不能在同一条思路上继续微调。
4. **不要全信 Explore / general-purpose agent 的纯文本搜索结论**。框架级行为（metadata、Suspense、Server Actions、middleware 边界）在代码里 grep 不到，必须自己读框架文档/语义。
5. **不知道就承认不知道，立刻去验证**。"可能你 build 是旧的，刷新一下" 这种话只有自己跑过、复现过、再排除的时候才能说。直接甩给用户是在逃避。
6. **fix-test-ship 循环里，至少每两轮停一次，问自己"我的假设可不可能是错的？如何用一个实验区分对错？"**。否则容易陷入 confirmation bias 的死循环。
