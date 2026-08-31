# 多 agent 任务组在任务列表里不分组

## 症状

前端创建多 agent 任务（worker + reviewer），任务都建出来了，但在任务列表里是**几张
互不相关的独立卡片**，不会合成一张 tab card。而且 reviewer 任务**当场根本不出现**，
要切项目或刷新之后才冒出来，标题是 `Reviewer: <agent>`。

用户的描述是"自动分组好像没有 100% 稳定实现"。实际不是偶发 —— 成功率是 0。

## 根因

仓库里有**两套完全独立、互不相通的 "group"**：

| | UI 分组（tab card） | RFC 0033 执行分组 |
|---|---|---|
| 载体 | `user_preferences` 表 + localStorage | `tasks.group_id` 列 |
| 触发 | 拖拽合并 / `parent_task_id` / restart 后继任务 | `POST /tasks` 带 `agents[]` |
| 前端列表可见 | 是 | **否** |

多 agent 创建只写了后者，而任务列表只读前者。中间有**四处独立断点**，任何一处单独
存在都足以让分组失效：

**① 服务端从不为 agent 组写 UI 分组。**
`mergeRelatedTaskCardGroup` 在 `tasks/route.ts` 里的唯一调用点被 `if (parentTaskId)`
守卫，而 reviewer 的创建循环在这个 block **之后**执行，完全不碰它。

**② `groupId` 没有下发前端。**
`serializeTaskResponse` 的字段表里没有 `group_id`，前端 `Task` 类型也没有。前端连
"这几个任务属于同一组"都无从得知。

**③ 没有面向浏览器的 `task_created` 实时事件。**
前端 realtime store 的 case 列表里没有它（`task_created` 只发给 daemon socket）。
所以 reviewer 任务不会实时出现在列表里。

**④ `createTask` 把响应里的额外字段吃掉了。**
`api.post<Task>('/tasks', input)` 的泛型被声明成 `Task`，`normalizeTask` 只挑白名单
字段，于是 `reviewer_task_ids` 和 `task_card_groups_snapshot` 在这一步就没了，只有
1 个任务进列表。

补充：`parent_task_id` **web 前端一处都没发过**，只有 SDK/CLI 在用。所以那条
`grouping` 分支在浏览器场景下永远是 `undefined`，对这个问题毫无帮助。

## 修复

restart 后继任务路径（`tasks/[taskId]/restart/route.ts`）早就有一套**完全对称的正确
实现**，直接照抄即可，不需要新设计：

1. **服务端**：reviewer 循环结束后，对每个 reviewer 调
   `mergeRelatedTaskCardGroup(user.id, workerTask.id, reviewerTaskId)`，把最终快照
   随响应返回（复用 restart 的 `task_card_groups_snapshot` 字段名）并广播。
2. **前端 store**：`createTask` 的 POST 泛型扩成
   `Task & { reviewer_task_ids?, task_card_groups_snapshot? }`，收到快照就
   `applySnapshot`，收到 reviewer id 就逐个 `fetchTask` 拉进列表。

两个必须守住的点：

- **串行合并。** `mergeRelatedTaskCardGroup` 是"读快照 → 改 → 写回"同一行 preference，
  并发合并会互相覆盖，只有最后一个 reviewer 能留在卡里。
- **fail-soft。** 分组只是展示状态。任务已经创建并派发出去了，这里失败若让 POST 返回
  500，用户会以为没建成而重复创建一整组。

上限不冲突：`MAX_SYNCED_TASKS_PER_CARD = 50` vs `MAX_AGENTS_PER_TASK = 8`。

## 下次如何避免

- **同一个词指两套机制，是最容易埋雷的命名。** 这里 "group" 同时指执行期关系
  （`groupId`）和展示期分组（card group）。schema 注释其实已经写明了两者的区别，
  但实现新功能时只接了其中一套。**给同名的两套机制写清楚"谁负责渲染"，比写清楚
  "它们不同"更有用。**
- **没有实时事件的实体，创建方必须自己把它放进列表。** 主任务能出现是因为 POST
  响应直接返回了它；reviewer 是副产物，没有任何机制把它送到前端。凡是"一次请求创建
  多个实体"，都要检查除主实体外的其它实体怎么到达 UI。
- **过窄的响应泛型会静默吞掉字段。** `api.post<Task>` 让 `reviewer_task_ids` 和快照
  连类型错误都不报就消失了。服务端新增响应字段时，要同步检查调用方的泛型。
- **对称路径要一起改。** restart 早就正确处理了同类快照，create 却没有。发现某条
  路径缺功能时，先搜有没有已经做对的兄弟路径 —— 既是现成模板，也说明这是个已知
  需求而非新设计。
