# 0024 Project Hidden State Cross-Device Sync

## Status

Proposed

## Owner

TBD

## Date

2026-04-26

## Summary

让"项目是否隐藏"成为账号级别的状态，跨设备/跨浏览器同步。当前隐藏列表只保存在浏览器 `localStorage`，导致用户在 A 设备隐藏的项目，到 B 设备登录同一账号后仍然显示，体验不一致。本 RFC 在 `Project` 模型上新增 `hiddenAt` 字段，扩展现有 `PATCH /api/projects` 支持隐藏/取消隐藏，并把 store 里的 `hideProject / unhideProject` 改为乐观更新 + API 调用，同时一次性把已有的本地隐藏列表迁移到服务端。

## Context

- 当前的隐藏状态只存在浏览器侧，键名定义在 [web/src/features/projects/store.ts](/Users/duino/ws/conductor/.conductor/worktrees/cb863c18-33b1-49cd-8c5c-8487b6ba57ca/web/src/features/projects/store.ts:7-8)：
  - `conductor-hidden-project-ids`：被隐藏的 projectId 数组
  - `conductor-show-hidden-projects`：是否展示隐藏项的开关
- 读写工具函数：`readStoredHiddenProjectIds` / `writeStoredHiddenProjectIds` 见 [store.ts](/Users/duino/ws/conductor/.conductor/worktrees/cb863c18-33b1-49cd-8c5c-8487b6ba57ca/web/src/features/projects/store.ts:38-76)。
- Action：`hideProject` / `unhideProject` 见 [store.ts](/Users/duino/ws/conductor/.conductor/worktrees/cb863c18-33b1-49cd-8c5c-8487b6ba57ca/web/src/features/projects/store.ts:349-378)，**只更新 Zustand state + 写 localStorage，不发任何网络请求**。
- 服务端 `Project` 模型当前没有任何隐藏相关字段，见 [web/prisma/schema.prisma](/Users/duino/ws/conductor/.conductor/worktrees/cb863c18-33b1-49cd-8c5c-8487b6ba57ca/web/prisma/schema.prisma:85-113)。
- 现有 `PATCH /api/projects?projectId=...` 已经支持改 `name / metadata / binding`，见 [web/src/app/api/projects/route.ts](/Users/duino/ws/conductor/.conductor/worktrees/cb863c18-33b1-49cd-8c5c-8487b6ba57ca/web/src/app/api/projects/route.ts:465)；可以直接复用，无需新增 endpoint。
- UI 入口 `ProjectItem` 的 `onHide / onUnhide` props 见 [web/src/features/projects/components/ProjectItem.tsx](/Users/duino/ws/conductor/.conductor/worktrees/cb863c18-33b1-49cd-8c5c-8487b6ba57ca/web/src/features/projects/components/ProjectItem.tsx)（最近一次改动把"Hidden 标签"换成了"虚线文件夹图标"）。
- 默认项目 `defaultProject` 通过 `DefaultProject` 关系唯一存在，不能被隐藏（当前 UI 已经做了限制），新方案需要继续保持这个约束。

## Goals

- 项目隐藏状态成为**账号级别（per-user）**的持久状态，跨设备/跨浏览器同步。
- 在任意设备隐藏一个项目，同账号其他设备的下一次拉取或实时推送会立刻反映。
- 旧设备本地已经存在的 `conductor-hidden-project-ids`，**只在第一次升级后启动时**做一次一次性合并到服务端，避免长期"本地状态 + 服务端状态"双轨。
- 保留乐观更新体验：UI 点击隐藏立即生效，不依赖服务端 round-trip。
- 与现有 `Project` 列表查询、排序、绑定、binding-pending 等行为兼容。

## Non-Goals

- "是否展示隐藏项"的开关 (`conductor-show-hidden-projects`) **不**做跨设备同步，继续保留在 localStorage。这是视图偏好，每台设备独立体验更合理。
- 不对其他视图偏好（折叠状态、列宽等）一并做同步。
- 不引入"按用户对共享项目的偏好表"（`UserProjectPreference`）；当前 `Project` 已经是 per-user 拥有，直接在 `Project` 上加列即可。
- 不改变默认项目不能被隐藏这一约束。
- 不做"隐藏后自动归档/删除"等业务语义变化。

## Options Considered

### Option A：在 `Project` 上加 `hiddenAt DateTime?`（采纳）

- Pros
  - 现有 `Project` 已经有 `userId`，本身就是 per-user 资源，加列即可，不需要新表。
  - `hiddenAt` 既能表达布尔语义（`null` = 未隐藏），又能保留时间戳，未来可做"最近隐藏列表 / 自动取消隐藏"等扩展。
  - 复用现有 `PATCH /api/projects`，不需要新 endpoint。
  - 排序、查询都不需要改 schema，只需要在序列化时多带一个字段。
- Cons
  - 需要一次 Prisma migration（轻量，只加一列）。

### Option B：新增 `UserProjectPreference` 表，存 `(userId, projectId, hidden)`

- Pros
  - 如果未来项目变成"多个用户可共享一个 Project"，需要 per-user 偏好。
- Cons
  - `Project.userId` 当前就是单一用户拥有者，多对多场景没有 roadmap，过度设计。
  - 多一张表 + JOIN，查询/排序/序列化都要改。

### Option C：完全保留 localStorage，加一个手动"导出/导入"按钮

- Pros
  - 零后端改动。
- Cons
  - 不解决"换设备就重置"的核心痛点，仅仅延后了用户的不满。

## Proposed Design

### 1. 数据模型

在 [web/prisma/schema.prisma](/Users/duino/ws/conductor/.conductor/worktrees/cb863c18-33b1-49cd-8c5c-8487b6ba57ca/web/prisma/schema.prisma:85) 的 `Project` 模型上新增：

```prisma
hiddenAt DateTime? @map("hidden_at")

@@index([userId, hiddenAt])
```

新增 migration `web/prisma/migrations/<ts>_add_project_hidden_at/`：

```sql
ALTER TABLE "projects" ADD COLUMN "hidden_at" TIMESTAMP(3);
CREATE INDEX "projects_user_id_hidden_at_idx" ON "projects" ("user_id", "hidden_at");
```

> 不增加 `NOT NULL`，默认 `NULL` 表示未隐藏，符合所有历史数据的默认语义。

### 2. 服务端 API

复用 [web/src/app/api/projects/route.ts](/Users/duino/ws/conductor/.conductor/worktrees/cb863c18-33b1-49cd-8c5c-8487b6ba57ca/web/src/app/api/projects/route.ts:465) 的 `PATCH`：

- 入参新增可选字段 `hidden: boolean`（或 `hiddenAt: string | null`，二选一，方案推荐 `hidden: boolean` 简单直接）。
- 处理逻辑：
  - 校验：默认项目（`isDefault`）不允许 `hidden: true`，返回 400 `"Default project cannot be hidden"`。
  - `hidden === true` → `hiddenAt: new Date()`（如果当前已经是隐藏，则保留原值，避免抖动）。
  - `hidden === false` → `hiddenAt: null`。
- `serializeProject` 输出 `hidden: boolean` 字段（基于 `hiddenAt != null`），保持前端使用方便。
- `GET /api/projects` 不做服务端过滤，仍然返回全部，由前端按 `showHiddenProjects` 决定显示。

测试：在 [web/src/app/api/projects/route.test.ts](/Users/duino/ws/conductor/.conductor/worktrees/cb863c18-33b1-49cd-8c5c-8487b6ba57ca/web/src/app/api/projects/route.test.ts) 中补三个 case：
1. PATCH 普通项目 `hidden: true` → 200，返回 `hidden: true`，DB 中 `hiddenAt` 非空。
2. PATCH 默认项目 `hidden: true` → 400。
3. PATCH `hidden: false` → 200，`hiddenAt` 变 `null`。

### 3. 前端 Store 改造

修改 [web/src/features/projects/store.ts](/Users/duino/ws/conductor/.conductor/worktrees/cb863c18-33b1-49cd-8c5c-8487b6ba57ca/web/src/features/projects/store.ts:349-378)：

- 删除 `HIDDEN_PROJECTS_STORAGE_KEY` 相关的 localStorage 读写函数（`readStoredHiddenProjectIds` / `writeStoredHiddenProjectIds`）。
- 删除 store 里的独立 `hiddenProjectIds: string[]` 字段；隐藏状态直接读取每个 `Project.hidden`，store 只保留派生 selector：

  ```ts
  const hiddenProjectIds = state.projects.filter(p => p.hidden).map(p => p.id);
  ```
- `hideProject(projectId)` / `unhideProject(projectId)` 改为：
  1. 乐观更新本地 `projects[*].hidden`。
  2. `await apiClient.patch('/api/projects', { searchParams: { projectId }, body: { hidden: true|false } })`。
  3. 失败时回滚乐观更新并 toast 报错。
- `showHiddenProjects` toggle 仍然走 `SHOW_HIDDEN_PROJECTS_STORAGE_KEY`（保留现状）。

类型层：在 `web/src/shared/types` 的 `Project` 类型上新增 `hidden: boolean`（不暴露 `hiddenAt`，前端不需要时间戳）。

### 4. 一次性迁移本地隐藏列表

在 store 初始化（首次拉取 `/api/projects` 成功后）执行：

```ts
const localIds = readStoredHiddenProjectIds();   // 旧 localStorage
if (localIds.length > 0) {
  const knownIds = new Set(projects.map(p => p.id));
  const toHide = localIds.filter(id => knownIds.has(id) && !projects.find(p => p.id === id)?.hidden);
  await Promise.all(toHide.map(id =>
    apiClient.patch('/api/projects', { searchParams: { projectId: id }, body: { hidden: true } })
  ));
  // 写入完成后清掉旧 key，避免下次启动重复合并
  window.localStorage.removeItem(HIDDEN_PROJECTS_STORAGE_KEY);
}
```

要求：
- 静默执行，不弹 UI。
- 失败不阻塞登录流程，下次启动可重试（因为 key 还没删）。
- 默认项目即使在 localStorage 里，也跳过（被服务端 400 挡掉）。

### 5. 实时推送（可选，第二阶段）

如果项目对"另一设备隐藏后本设备立刻反映"有强需求，可以在 [web/src/lib/channel](/Users/duino/ws/conductor/.conductor/worktrees/cb863c18-33b1-49cd-8c5c-8487b6ba57ca/web/src/lib/channel) 现有 project 推送通道里加 `project_updated`，payload 带 `{ id, hidden }`，前端 reducer 直接合并。

第一阶段不强制：因为 `GET /api/projects` 在切换 tab、刷新、长时间空闲后都会重拉，多数场景能在分钟级收敛。

## Risks

- **乐观更新与服务端冲突**：双设备同时一个隐藏一个取消隐藏，最后一次写为准。可接受，因为操作是幂等的、可视的。
- **migration 失败**：只加一列且无默认值/约束，风险极小；按 [claw/sop/06_release.md](/Users/duino/ws/conductor/.conductor/worktrees/cb863c18-33b1-49cd-8c5c-8487b6ba57ca/claw/sop/06_release.md) 走标准发布流程。
- **localStorage 一次性迁移**：如果用户在迁移过程中关闭浏览器，下次启动会再尝试，幂等。需要确保 PATCH 失败不会清掉 key。
- **客户端版本错配**：旧前端不知道 `hidden` 字段，仍然按旧逻辑读写 localStorage，结果是"旧客户端不同步、新客户端同步"，不会破坏数据。无需特殊兼容代码。

## Rollout

1. **DB**：上线 migration `add_project_hidden_at`（独立部署，不和代码改动一起灰度）。
2. **后端**：发布带新 PATCH 字段支持的 web，向后兼容（旧 client 不发 `hidden` 即维持旧行为）。
3. **前端**：发布带新 store 逻辑的 web，包含 localStorage 一次性迁移。
4. **观察 1 个 sprint**：监控 `PATCH /api/projects` 错误率，确认 `hidden` 字段没有引入 400/500 抖动。
5. **下一个 sprint** 再决定是否做实时推送（Stage 2）。

## Acceptance

- 用户在设备 A 隐藏项目 X，在设备 B（同账号）刷新页面后 X 默认不显示；点击"显示隐藏项目"后 X 出现在隐藏列表中。
- 用户清除浏览器数据后，隐藏列表仍然由服务端恢复。
- 默认项目无法被设置为隐藏，PATCH 返回 400。
- 旧版客户端遗留的 `conductor-hidden-project-ids`，在新前端首次启动后被自动同步到服务端并从 localStorage 清除。
- 单元测试覆盖：API PATCH 三种 case、store action 乐观更新+回滚、迁移逻辑幂等。

## Open Questions

- 是否要为"隐藏时刻"提供 UI 展示（例如 hover 时 tooltip 显示 "Hidden 3 days ago"）？v1 不做，但保留 `hiddenAt` 数据。
- 是否需要"批量隐藏 / 批量取消隐藏" API？v1 走多次单条 PATCH，监控 QPS 决定是否合并。
- 跨设备同步是否要扩展到"项目排序 `sortOrder`"？该字段已经在数据库里，但 reorder API 已经覆盖，不在本 RFC 范围。
