# 任务列表在 130+ 任务时明显卡顿

- 类型：misc（性能 / 交互卡顿）
- 日期：2026-08-24
- 涉及：`web/src/app/api/tasks/route.ts`、`web/src/features/tasks/components/TaskItem.tsx`、`web/src/features/tasks/components/TaskList.tsx`

## 症状
一个拥有 130+（线上实测 170，其中 159 active）任务的用户反馈：
1. 使用过程中（尤其有任务在跑时）明显卡顿；
2. 不同页面之间切换也有明显的"冻一下"。

## 定位方法（先量化再改）
- 后端：拷贝真实库到 `/tmp` 灌到目标规模，量 `/api/tasks` 里 `buildTaskMessagePreviews` 的真实 Prisma 路径；并用 `git stash` 在同一数据集上做 OLD/NEW 真实 HTTP 对比。
- 前端：Playwright 驱动真实 Chrome，注入 `conductor.jwt` 登录，量初始渲染、切页、以及"单任务更新触发多少张卡重渲染"（临时埋点计数，量完移除）。
- 线上：只读 SQL 确认真实数据形态（`AVG(LENGTH(content))`）——结果消息很小（avg 125B），说明后端并非主因，前端才是。

## 根因
1. 前端主因（re-render 风暴）：`TaskItem` 用 `useTasksStore()` **无 selector 全量订阅**，且组件未 `memo`。任意一条 WebSocket 消息 → `updateTaskInList` 替换 tasks 数组引用 → 每条消息**重渲染全部 162 张卡**（实测）。
2. 前端次因（切页卡）：任务列表**无虚拟化**，159 张卡（约 1 万 DOM 元素）全量挂载；每次切页整棵列表销毁重建。
3. 后端（非当前主因，但是隐患）：`buildTaskMessagePreviews` 为了取每个任务"最后一条 user/assistant 消息"，用 `findMany` **无 LIMIT** 加载所有 user/assistant 消息的完整 `content`。在重量数据（长 transcript）下单请求可达 705ms / 堆 +213MB。真实线上数据消息很小所以当前不痛，但随历史增长会恶化。

## 修复
1. 后端：预览查询改为**窗口函数**（`ROW_NUMBER() OVER (PARTITION BY task_id, role ORDER BY created_at DESC, id DESC)` 取 rn=1）只取每任务最新 user/assistant 各一条，`SUBSTR` 服务端截断到 200 字符。附 `try/catch` 回退到 Prisma-typed `findMany`（兼容 Postgres uuid 等方言差异）。实测（重量数据）：575ms→60ms、1.13MB→144KB。
2. 前端 memo：`TaskItem` 的 `useTasksStore()` 换成 7 个 per-action 窄 selector（action 引用稳定），组件包 `React.memo`；`TaskList.toggleTaskSelection` 加 `useCallback` + 用 `useEffect` 维护的 `visibleTaskIdSetRef`，避免回调每次 WS 更新换引用而破坏 memo。实测：单任务更新重渲染 **162→1**。
3. （未做，另起一轮）列表虚拟化：解决"切页那一下卡"的剩余成本。

## 如何避免下次再犯
- Zustand：列表项组件**永远用窄 selector**（`useStore(s => s.field)`），禁止 `useStore()` 无参全量订阅；长列表项默认 `React.memo`，并确保传入的回调/派生 props 引用稳定（`useCallback` + 必要时 ref）。
- 传给 memo 组件的 props 若依赖"每次更新换引用"的派生值（如 `new Set(...)`），用 ref 在 effect 中持有最新值，别放进回调依赖数组。
- 后端"取每组最新一条"用窗口函数，不要"全量加载再内存里扫"；预览类字段服务端截断。
- 长列表（>50 项）默认上虚拟化。
- 性能问题先量化（真实数据规模 + 真实浏览器/HTTP），再定位主因，避免改错地方。
