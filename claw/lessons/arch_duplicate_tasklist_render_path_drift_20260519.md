# Tasks 页两条 TaskList 渲染路径不同步，合并项目在单栏视图下列表为空

## 症状
继上一次 "合并 project 的任务列表只显示其中一个 daemon 的 task" 修复之后，用户在非桌面（mobile / single-pane）视图下再次复现：选中合并项目（如 `Conductor`）时，页面标题正确显示了任务总数（例如 "Conductor (2 tasks)"），但下方的任务列表里**什么都没有**。桌面分栏视图（`inlineDetailEnabled = true`）正常。

## 根因
`web/src/app/app/tasks/page.tsx` 在 JSX 里有**两条** `<TaskList />` 渲染路径，互为镜像：

- 第 380 行附近：桌面分栏视图，`inlineDetailEnabled` 为 `true` 时使用。
- 第 409 行附近：单栏视图，`inlineDetailEnabled` 为 `false`（手机端 / 非桌面）时使用。

上一次修复时，我只把**桌面分栏分支**的 `projectFilter` 从 `{projectId}` 改成了 `{projectScope.length > 0 ? projectScope : null}`，**单栏分支被漏掉了**。所以在单栏视图下：

- 页面层 `taskCount` 仍然走 `projectScope`（数组），合并群组下能拿到所有成员 daemon 的任务 → 标题"2 tasks"正确。
- 但 `<TaskList projectFilter={projectId} />` 收到的是 URL 里那个**单**成员 id；TaskList 内部 `filterTasksByProject` 严格按单 id 过滤。
- 用户最初点开合并项目时，URL 的 `projectId` 经常是没有任务的那个 daemon 的成员（"代表"成员），实际任务都在**另一个** daemon 的成员上 → TaskList 过滤后 0 条 → 列表空。

这正是"标题数对、列表空"的对称错配。

## 修复
把单栏分支也改成相同表达式：

```tsx
projectFilter={projectScope.length > 0 ? projectScope : null}
```

并在代码处加注释明确"两条分支必须保持一致"，让后续阅读者一眼看见这是个需要并修的对子。

为什么之前的测试没拦住：`page.test.tsx` 里 `TaskList` 的 mock 接收 `projectFilter` 但**完全没有把它体现到 DOM**，因此 "page 层 setProjectGroupFilter 调用 + 标题 2 tasks" 这两条断言都成立，可 mock 收到的 prop 是错的也无人察觉。

测试侧的修复：
1. 把 `TaskList` mock 改成把 `projectFilter` 渲染成 `project-filter:none | single:X | group:a,b` 文本，使 prop 可被断言。
2. 让原本就在跑单栏路径（默认 `isDesktopViewport = false`）的合并项目用例加上 `expect(screen.getByText('project-filter:group:proj-host-a,proj-host-b')).toBeInTheDocument()`——这一条断言在未修 bug 时直接红。
3. 额外新增 `isDesktopViewport = true` 的桌面分栏路径用例做同等断言，两条路径都被显式覆盖。

## 下次怎么避免
1. **同一份组件被并列渲染多次时，所有 prop 必须 1:1 对齐**：JSX 里同一个组件出现在 `if/else` 两个分支，本质就是同一份代码被复制粘贴。每次给其中一份加 prop 或改表达式，应该**机械地**把另一份也同步——必要时把 prop 集合提到一个 `taskListProps` 常量里再 spread (`<TaskList {...taskListProps} />`)，让"漏改一边"在编译/审阅阶段就显形。
2. **mock 一定要把"被测 prop"体现到可断言出口**：当用 mock 替换组件来隔离被测页面时，**凡是测试关心的 prop 都要让 mock 渲染到 DOM/调用记录里**，否则页面把错 prop 传下去也能让"页面层断言"过关，让测试给出虚假的安全感。这次新增的 `project-filter:...` 文本就是为此存在。
3. **抓"对称错配"类型的 bug，至少要在两条对称路径上各跑一遍同等断言**：当一个 page 因 viewport / 模式分裂出两条渲染路径，又同享一份"对外契约"（这里是"传给 TaskList 的 projectFilter 必须是展开后的群组"），就得在两条路径上各写一条同等测试，而不是只挑常用那条覆盖。
