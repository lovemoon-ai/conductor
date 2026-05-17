# 合并 project 的任务列表只显示其中一个 daemon 的 task

## 症状
跨 daemon 把多个同名 project 合并成一个 merged project 之后，在 UI 中点击该合并项目，任务列表只显示其中一个 daemon 上的 task；其它 daemon 上同名 project 下的 task 完全看不到。Issues 列表是正确的。

## 根因
"合并 project" 是纯前端聚合概念：`ProjectGroup` 在 UI 上把多个独立的 `Project` 行（每行对应一个 daemon 的 `daemonHost`）展示成同一个条目，但数据库里依然是多条 `Project` 记录、多条不同 `projectId` 的 `Task` 记录。

Issues 链路已经针对 merged group 做了适配：
- 后端 `/api/issues` 既接受 `project_id`，也接受 `project_ids`，后者走 `projectId: { in: [...] }`。
- 前端 `useSelectedProjectGroupIds()` + `fetchIssuesForProjects(memberIds)` 把 group 的所有成员 id 一次性传给后端。

但 Tasks 链路漏改了：
- `/api/tasks` 只接受单个 `project_id`，`db.task.findMany` 只能按一个 projectId 过滤。
- `useTasksStore.fetchTasks(projectId)` 也只发单个 `project_id`。
- `filterTasksByProject(tasks, projectId)` 用 `task.projectId === projectId` 严格等值匹配。
- `/app/tasks` 页面读到 URL 上的单个 `projectId` 后，直接当作过滤值传给 store 和 filter，从没展开成 group 成员列表。

结果：用户选中的合并项目对应的是 URL 里一个具体成员 id（比如 daemon A 上的那个 projectId），后端、store、前端 filter 都只针对这一个 id 工作，自然只看得到 daemon A 的 task。

## 修复
完全对照 issues 链路把整条 task 链路升级为支持"多 projectId scope"：

1. `web/src/app/api/tasks/route.ts`
   - 新增 `project_ids=a,b,c` 查询参数，和 `project_id` 互斥，合用返回 400。
   - 新增 `buildProjectIdFilter(projectIds)`：单 id 仍走 `projectId = ?` 保留原查询计划，多 id 走 `projectId IN (?)`。
2. `web/src/features/tasks/utils/task-filter.ts`
   - `filterTasksByProject` 接受 `string | string[] | null | undefined`，内部统一规范成 id 集合后用 `Set.has` 过滤。
3. `web/src/features/tasks/store.ts`
   - 新增 `currentProjectIds` 状态、`fetchTasksForProjects` 和 `setProjectGroupFilter` 动作，请求 `/tasks?project_ids=...`。
   - `setProjectFilter` 同步清空 `currentProjectIds`；`fetchTasks` race-guard 同时检查两个字段，确保 merged ↔ single 切换不会用过期响应覆盖最新数据。
4. `web/src/app/app/tasks/page.tsx`
   - 用 `computeProjectGroups(projects)` 把 URL 上的单个 `projectId` 展开成所属 group 的全部成员 id；当 group 大于 1 时调用 `setProjectGroupFilter` / `fetchTasksForProjects`，否则保持原 single-id 路径。
   - 把同样的"展开后 id 列表"（`projectScope`）传给 `filterTasksByProject` 和 `<TaskList projectFilter>`。
5. `web/src/features/tasks/components/TaskList.tsx`
   - `projectFilter` 接受 `string | string[] | null`；merged 时 `showProjectInfo=true` 保留每张卡片的 daemon host 标签便于辨识来源；`activeProjectFilter` 在 merged 时传 `null` 避免错误高亮。
6. `web/src/features/realtime/hooks/useWebSocket.ts`
   - WebSocket 重连后的兜底拉取也要看 `currentProjectIds`：是 merged scope 就 replay `fetchTasksForProjects`，否则才走 `fetchTasks`。否则一次断网重连会把任务列表悄悄裁回单 daemon。

新增测试：filter util 数组语义、store `fetchTasksForProjects` 含一个 race-condition 用例、route `project_ids` 与互斥 400、`/app/tasks` 页面 merged-group 展开路径、`useWebSocket` merged 重连路径。

## 下次怎么避免
1. **UI 聚合概念必须贯穿三层**：只要后端是按 id 单值查、前端却把多个同名实体合成一个"虚拟"实体展示，迟早会出现"展示出来的容器 ≠ 查询出来的内容"。新增聚合视图时应该先评估"这个聚合在哪一层落地"，并同步打通 API → store → filter → 组件 props 全链路。
2. **跨链路同构检查**：Issues 已经做对了，Tasks 漏改，说明这种"两个链路应当对齐"的约定没有显式登记。后续可以在仓库里加一份"跨 daemon merged-project 影响清单"（issues, tasks, messages, files, ...），任何引入聚合的新链路都要逐项确认。
3. **race-condition 字段要同步清理**：`currentProjectFilter` 加了兄弟字段 `currentProjectIds` 之后，所有 race-guard、setter、WebSocket fallback 都要同步看新字段，否则会出现"一次断网把视图悄悄回退"这种隐蔽 bug——已经在 `useWebSocket` 和 `fetchTasks` 的 guard 里都打了补丁，并写了用例固化。
