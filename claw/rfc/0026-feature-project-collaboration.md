# 0026 Project Collaboration (Shared Issue Board)

## Status

Proposed

## Owner

TBD

## Date

2026-05-09

## Summary

让多个用户在共享的 Issue Board 上协作完成同一个功能：每个成员各自带一个本地 `Project`（绑定自己的 daemon / workspace），通过一个 `ProjectCollaboration` 把这些项目"拼"成一个共享视图。Issue 仍然落在某个具体 `Project` 上（即 issue 创建者那一侧），但所有成员都能看到、能改 owner、能在自己一侧把 issue 推进 `doing` 并在自己 daemon 上跑 task。整个 MVP 限制：单个协作最多 5 人、不引入审批 / 踢人 / 计费。

## Context

- 当前 `Project` 是单用户资源（`Project.userId` = 唯一 owner）。Issue 与 Task 都通过 `Project` 隐式归属同一个 user。
- 没有任何"跨账号共享 issue / 任务"的机制：用户 A 和用户 B 想协作做同一个项目，只能各自手工建项目、各自跑任务、互相截图。
- 我们要做的是**最薄的一层**多人协作：共享 issue board（拉齐"现在要做什么"），但每个人的本地 task 仍然只跑在自己 daemon 上。
- 与之相关的现有事实：
  - `Issue` 没有 `ownerUserId` / `creatorUserId`，只有 `projectId` —— 隐式 owner = `project.userId`。
  - Task 启动逻辑（`/api/issues/[issueId]` PATCH 的 `todo → doing` 路径）当前完全假设 `project.userId === user.id`，会用 `existing.project` 的 daemon / workspace / repoRoot 信息直接 spawn。
  - Project 列表 API (`/api/projects` GET) 永远 `where: { userId }`，没有跨账号的概念。
- Project 已经有 sortOrder / hiddenAt 等 per-user 字段，加列继续走 Project + 关联表的方向是可行的。

## Goals

- 一个 `Project` 的 owner 可以发邀请链接，让其它账号"用自己的 Project 加入这个协作"。
- 加入协作后，所有成员看到的 issue board 是这几个 Project 的并集：
  - GET `/api/issues` 包含跨成员的 issue。
  - GET `/api/issues/[id]`、PATCH、DELETE 也允许任意成员访问。
- Issue 引入显式 `ownerUserId` 和 `creatorUserId`，UI 上可以把 issue assign 给任意协作成员；assign 之后 `doing` 由 owner 在自己一侧的 Project 跑。
- 每位成员只能"用自己的 Project 加入一个 collab"（一对一），方便未来的共享态推到 daemon。
- 5 人上限在并发 join 下也不能被绕过。
- 离开协作不会留下"指向已不可见用户的 issue 引用"，即不允许出现 dangling owner / dangling running task。
- Schema 和 Postgres 保持 parity（`schema.postgres.prisma` 同步加同样的模型与索引）。

## Non-Goals

- **不**做"踢人 / 转让 owner / 解散按钮"。任何成员只能 leave 自己。
- **不**做"邀请码失效 / 重新生成"（MVP 期内 token 一直有效；要更换得整组 leave 后重建）。
- **不**做计费、配额、订阅升降级跟协作绑定。
- **不**实时推送其它成员的 issue 变化（依赖现有的 polling / refresh 流程，下一阶段再上 WS 广播）。
- **不**支持单个 user 用同一个 Project 加入多个 collab（`projectId @unique` 强制 1:1）。
- **不**允许 default project 加入协作 —— UI / 两条 API 路径 / 邀请页 candidate 列表三处一并屏蔽。
- **不**修改 Task 的可见性：每个用户的 task 还是只在自己 daemon 上跑，跨成员看不到对方在跑什么 task。

## Options Considered

### Option A：`ProjectCollaboration` + `CollaborationMember` 关联表（采纳）

- 模型
  - `ProjectCollaboration { id, inviteToken @unique, createdAt }`：协作单元 / 邀请源。
  - `CollaborationMember { id, collaborationId, userId, projectId @unique, joinedAt, @@unique([collaborationId, userId]) }`：把"用户 + 自己的 Project"绑到协作上。
  - `Project.collaborationId` 软外键（`onDelete: SetNull`）：让 Project 列表查询保留"我属于哪个 collab"信息，便于序列化时一次返回 member 列表。
  - `Issue.ownerUserId` / `creatorUserId`：替代原来的"隐式 owner = project.userId"。
- Pros
  - Schema 上每个不变量都能用 unique 约束兜底：`projectId @unique` → 一个 Project 不会同时进两个 collab；`(collaborationId, userId) @unique` → 同一个 user 不会在同一个 collab 里出现两条 member 记录。
  - 5 人上限不依赖应用层"读 → 算 → 写"，可以用"先 insert，再 count"的方式让超额并发场景失败回滚。
  - 不要求把多个用户的 Task 强行塞进一个 Project，避免 daemon / workspace 字段语义破坏。
  - 离开协作可以原子地解绑、转让 issue ownership、删 collab。
- Cons
  - Issue 实体跨 user 复杂度上升（owner 可以来自另一个 user 的 Project 内的 issue）；route 必须显式做"我能 access 哪些 projectId"的扫描。
  - "邀请链接 + 选择本地 Project 加入"是个独立 UI 流，需要新页面 `/app/invite/[token]`。

### Option B：把"协作项目"做成一个新的 `SharedProject`，每位成员的本地 Project 作为"克隆"

- Pros：模型更显式。
- Cons：Project 表所有调用方（task spawn / daemon 绑定 / metadata / hidden / sort）都要分叉两条路径。MVP 不值得。被否决。

### Option C：在 `Project` 上多挂一个 `Project[] sharedWith` 多对多

- Pros：实现快。
- Cons：没有"协作单元"的概念，5 人上限要在应用层维护；离开协作时 owner 转让逻辑没有落点；邀请 token 也要挂在某个具体 Project 上，整个语义有点脏。被否决。

## Detailed Design

### Schema (`web/prisma/schema.prisma` + `schema.postgres.prisma` parity)

```prisma
model ProjectCollaboration {
  id          String   @id @default(uuid())
  inviteToken String   @unique @map("invite_token")
  createdAt   DateTime @default(now()) @map("created_at")
  members  CollaborationMember[]
  projects Project[]
}

model CollaborationMember {
  id              String   @id @default(uuid())
  collaborationId String   @map("collaboration_id")
  userId          String   @map("user_id")
  projectId       String   @unique @map("project_id")
  joinedAt        DateTime @default(now()) @map("joined_at")
  @@unique([collaborationId, userId])
  @@index([userId])
  @@index([collaborationId])
}

model Project {
  // ...
  collaborationId String? @map("collaboration_id")
  collaboration ProjectCollaboration? @relation(fields: [collaborationId], references: [id], onDelete: SetNull)
  collaborationMember CollaborationMember?
  @@index([collaborationId])
}

model Issue {
  // ...
  ownerUserId  String @map("owner_user_id")
  creatorUserId String @map("creator_user_id")
  owner   User @relation("IssueOwner",   fields: [ownerUserId],   references: [id], onDelete: Cascade)
  creator User @relation("IssueCreator", fields: [creatorUserId], references: [id], onDelete: Cascade)
  @@index([ownerUserId])
  @@index([creatorUserId])
}
```

迁移文件 `web/prisma/migrations/20260503120000_project_collaboration/migration.sql` 通过 SQLite "RedefineTables" 把已有 issues 行的 `owner_user_id` / `creator_user_id` 都填成 `projects.user_id`，保证升级前的存量数据不会出现 NULL。

### Service (`web/src/lib/collaboration/service.ts`)

- `MAX_COLLABORATION_MEMBERS = 5`：唯一一处硬编码，方便后续抬升。
- `createCollaborationInviteToken()`：32 字节 base64url，~256 bit 熵。
- `getAccessibleProjectIds(userId)`：返回 own projects ∪ 同协作内其它成员的 projects。
- `getProjectIssueScope(userId, projectId)`：
  - `projectId === null` → 走 `getAccessibleProjectIds`，跨协作并集（用于"All Issues"视图）。
  - `projectId !== null` 且我是 owner → 如果该 project 没 collab 则 `[projectId]`，有 collab 则展开成"该 collab 全部成员的 projectId"，让 board 视图保持完整。
  - `projectId !== null` 但我不是 owner → 必须能找到一条 `(collaborationId, userId)` member 记录，否则返回 `null` → API 层 404。
- `getAssignableIssueOwnerIds(project)` / `isAssignableIssueOwner(project, ownerUserId)`：约束 issue owner 只能落在协作成员集合里。
- `serializeCollaboration` / `serializeCollaborationMember`：同时返回 camelCase 与 snake_case，跟项目其它序列化口径保持一致；MVP 也把 `inviteUrl` 一起返回（API 端基于 `request.url` 拼），客户端 fallback 用 `window.location.origin`。

### API endpoints

| Method | Path | Behaviour |
| --- | --- | --- |
| POST | `/api/projects/[projectId]/collaboration` | Project owner 创建 collab + 自动以自己为第 1 个 member。事务内置 `where: { id, userId }` 防止给别人 project 建邀请。`projectId @unique` 在并发场景里兜底（P2002 → 409）。 |
| POST | `/api/collaboration/join` | 接受邀请。serializable 事务 + 先 `create` 再 `count > MAX` 校验，超额时抛 `CollaborationFullError` 回滚；P2034 retry 一次后失败给 409。 |
| DELETE | `/api/collaboration/[collaborationId]/members/me` | 离开协作：见下面 *Leave 流程*。 |
| GET | `/api/invitations/[token]` | 邀请页拉协作信息 + 当前账号能用来配对的本地 project 列表。 |
| 现有 `/api/issues*` | | 全部改走 `getAccessibleProjectIds` / `getProjectIssueScope`，PATCH 多带 owner 校验。 |

### Issue 生命周期 (`/api/issues/[issueId]` PATCH)

- 只有 issue 当前 owner 才能：
  - 把 issue 从非 `doing` 推进 `doing`
  - 把 `doing` 状态推进到其它状态
- 任何成员（在 `doing` 之外）都可以改 owner，但目标 owner 必须是协作成员。
- `doing` 状态下不允许换 owner（避免跑到一半把 task 主权迁走）。
- 进入 `doing` 时若 issue 的 ownerUserId 不是 issue 所在 project 的 owner，会用 `getUserProjectForCollaboration(user.id, collaborationId)` 找到 owner 自己一侧的 project，然后在那一侧 spawn task —— 保证 task 永远跑在 owner 自己的 daemon 上。
- "doing → done" 还是先 stop active task 再写 status，并发 claim 用 `updateMany` 的 `where: { id, status: previous }` 兜底。

### Leave 流程

`DELETE /api/collaboration/[collaborationId]/members/me`：

1. 查询当前 user 在该协作下的 member 行，404 if missing。
2. 拿"剩余 member 列表"（按 `joinedAt asc`）。
3. **预检**：
   - 若我在剩余成员的 project 里有 `doing` / `review` 的 issue → 409 `Move owned running issues out of doing before leaving collaboration`。
   - 若我自己 project 里有别人 own 的 `doing` / `review` issue → 409 `Ask collaborators to move running issues out of doing before leaving collaboration`。
4. 删 `CollaborationMember` 行；把 `Project.collaborationId` 设回 null。
5. 若还有剩余成员：把"我 own 的、落在剩余 project 里的 issue"全部 `ownerUserId` 改成 `remainingMembers[0].userId`（最早加入的成员）。
6. 把"我 project 里 owner 不是我的 issue"全部 `ownerUserId` 改回我自己 —— 离开后这个 project 重新变成单租户，不能继续指向"我已经看不见的 user"。
7. 若剩余成员为空，删 `ProjectCollaboration` 行（cascade member 残留）。

这一组步骤保证：离开后既不会出现 dangling owner，也不会出现"task 还在 owner 那边跑、issue 已经被对方拿走"的孤儿。

### 5 人上限的并发安全

- 邀请页拉到的"已满"信息只是 hint。
- 真正校验在 `POST /api/collaboration/join`：
  - 进 serializable transaction。
  - 先 `findUnique` 拿当前 members；若 `>= MAX` 直接 409（fast path）。
  - 否则 `collaborationMember.create`，然后 `collaborationMember.count(...)`：如果 `count > MAX`，抛 `CollaborationFullError` 让 transaction rollback。
  - P2034（serialization conflict）允许重试一次；再失败直接给 409 `Collaboration join conflicted, please retry`。
- `projectId @unique` 在 schema 层挡住"两个浏览器同时把同一个 Project 加进来"的极端场景（P2002 → 409）。

### 邀请链接

- 链接形如 `${origin}/app/invite/${inviteToken}` —— `inviteToken` 是 32B base64url。
- 邀请页 `web/src/app/app/invite/[token]/page.tsx` 强制要求登录（`getActiveSubscriptionUser` 走 401 重定向流程），让 token 不能匿名探测。
- 当前账号没有可配对的 project（全部已经 `collaborationId` 非空）时，UI 给"先离开另一个协作或新建项目"提示。
- token 不会自动失效；如果泄露，唯一的应对是该 collab 的成员全部 leave 让协作消亡。

### Frontend

- `useProjectsStore`：`startProjectCollaboration` / `leaveCollaboration` 两个 action，乐观更新对应 `Project.collaboration*` 字段。
- `ProjectItem`：每个 project 卡片底部新增 Invite / Leave 按钮和 "N/5 members" chip。
- `IssueCard.IssueOwnerMenu`：协作成员 ≥ 2 才出现 owner 头像菜单。
- `CreateIssueDialog`：
  - 当选中的 project 有协作时显示 owner 下拉。
  - 默认 owner 选"配对该 project 的 member"，即在自己 project 创建的 issue 默认 owner = 自己。
- `IssueBoard`：drag/drop 期间按"被拖动的 issue 所属 project"计算 position，避免跨 project 的 issue 互相挤占顺序值。

## Trade-offs / Open Questions

- **Token 不轮转 vs. 邀请窗口**：MVP 选择"链接永久有效，凭 leave 解决泄露"，简单。如果未来有 SLA 要求，需要新加 `expiresAt` + revoke 接口。
- **Leave 反向迁回所有非 self issue 是否过激**：当前实现把"离开 project 内非 self owner"全部转回 self，相当于强制"project 私有化的瞬间归零"。代价：协作信息（"这个 issue 当时是 user-2 owner"）丢失。MVP 接受这一刀；后续可以加 `legacyOwnerUserId` audit 字段。
- **Default project 不允许加入协作**：default project 是用户的本地 personal scratch，不参与跨账号共享。具体禁止点：
  - UI：`ProjectItem` 在 `isDefault` 时不渲染 Invite 按钮（Leave 仍保留作为遗留状态的逃生通道）。
  - API：`POST /api/projects/[id]/collaboration` 在事务内一起取 `defaultProject` 关系，命中即回 400；`POST /api/collaboration/join` 同样在 `targetProject` 一侧拦截；`GET /api/invitations/[token]` 直接把 default project 从 candidate 列表里过滤掉。
- **Cross-tenant 实时性**：本 RFC 没改 WS 广播；其他成员的 issue 变化得靠刷新或自然 polling。下一阶段再补 `realtimeHub` 推送即可。

## Migration / Rollout

- 单一 schema migration（`20260503120000_project_collaboration`）：
  - 加 `project_collaborations` / `collaboration_members` 表。
  - `projects` 加 `collaboration_id` 列 + 索引。
  - `issues` 加 `owner_user_id` / `creator_user_id`，回填值取自 `projects.user_id`，索引同步。
- 上线后：
  - 先后端走通；前端"Invite / Leave"入口默认显示，但旧客户端的 `/api/projects` 序列化也会带上 `collaboration: null`，没有破坏性变化。
  - 老 issue 行的 owner / creator 默认就是当年的 project.userId，所有现有视图行为不变。

## Test Strategy

- API 层 unit + route mock 测试：
  - `web/src/app/api/projects/[projectId]/collaboration/route.test.ts`：owner 创建 → invite URL。
  - `web/src/app/api/collaboration/join/route.test.ts`：正常加入 / 满员拒绝 / 并发超额回滚。
  - `web/src/app/api/collaboration/[collaborationId]/members/me/route.test.ts`：离开时 issue ownership 迁移、running 状态阻塞、最后一人解散。
  - `web/src/app/api/issues/[issueId]/route.test.ts`：non-owner 不能 enter/exit doing、owner change 限制、collab spawn 走 owner 自己的 project。
- Frontend 组件测试：`IssueBoard.test.tsx` 加 owner 菜单 forward 用例。
- 完整链路：`pnpm test --run` 全部 838 用例必须保持绿。

## Lessons Already Captured

- 并发加入超额需要"先 insert 再 count"的 self-check —— 单纯 read-modify-write 在 serializable 之外仍可能漏掉一个。
- "leave 时把 doing 关掉"是必须的硬阻塞：否则 task 会在原 owner 那边孤儿运行，issue 又指向已不可见的成员。
- collab 内的 issue 不应该让"非 owner"动状态机；否则 owner 那边的 task 会被远端推到不一致的状态。
- **不要把 owner 转让当作所有人都能做的操作** —— 一开始的实现允许任何成员通过 PATCH `{ ownerUserId: 自己 }` 抢走别人的 issue，再 PATCH `{ status: 'doing' }` 在自己 daemon 上 spawn task。等于无声越权，需要在 PATCH 路径里强制 caller 必须是当前 owner 或 project owner。
- **member 序列化默认不要带原始 email/phone**：邀请页只要登录态就能拉取协作信息，如果 serializer 直接 echo 出 `email`/`phone`，等于把成员通讯录暴露给任何拿到邀请链接的账号；只暴露 `label` 即可。

## Known Limitations / Deferred Hardening

下列条目是 review 过程中识别出但 MVP 不解决的项目，留作 follow-up。每条都列出已知触发场景与建议的修法：

- **Postgres 上的 schema parity / Postgres migration 缺位**：当前所有 prisma migration 文件都是 SQLite 方言（`DATETIME` 等），`schema.postgres.prisma` 和 SQLite schema 也长期存在 drift（例如 `hidden_at` 在 RFC 0024 加进 SQLite 时没同步 Postgres）。本 RFC 的 `ProjectCollaboration` / `CollaborationMember` 在 Postgres schema 里有，但没有对应的 Postgres migration 文件。上 Postgres 部署前需要补一组 PG migration —— 这是整个仓库的 schema 演进策略问题，本 RFC 不在此处展开。
- **5 人上限在 Postgres 上的并发**：`POST /api/collaboration/join` 已经用 `isolationLevel: Prisma.TransactionIsolationLevel.Serializable` 包了整个事务，并在 insert 之后再 `count()` 做 post-write self-check。Postgres SSI 会为这种 `findMany WHERE collaboration_id=X` 形式的读取建立 SIREAD 谓词锁；两个并发 join 都通过 5 人门槛时，SSI 检测到 read-write 反依赖环，会用 `40001`（Prisma 映射成 `P2034`）回滚其中一个。代码已经做了一次 P2034 retry。理论上仍可能出现"两个 join 全 retry 失败 → 都回 409"的 UX 退化，但 cap 不会被突破。如果产品想完全消除 retry 失败带来的 UX 抖动，可以加 `SELECT id FROM project_collaborations WHERE id=$1 FOR UPDATE` 把并发变成排队 —— 但这是优化，不是 correctness fix。
- **`Issue.ownerUserId` / `Issue.creatorUserId` 的 `onDelete: Cascade`**：如果 user-2 账号被删除，user-2 own 或 created 的 issue 会被级联清掉，包括落在 user-1 项目里的那些 —— 跨 tenant 数据丢失。修法是把这俩字段改成 nullable + `onDelete: SetNull`，UI 显示 "Unassigned"；本 RFC 暂不做这个迁移。
- ~~**邀请链接里嵌入 `request.url` 的 Host**~~ ✅ 已修：`buildInviteUrl` 优先使用 `NEXT_PUBLIC_BASE_URL` / `NEXT_PUBLIC_URL` 环境变量构造 origin，只有在两者都未配置时才 fallback 到 `request.url`（仅用于本地 dev）。这样反代即使没正确剥 `X-Forwarded-Host`，攻击者也没法让响应里嵌入伪造的钓鱼域名。
- **PATCH issue spawn 路径上的窄竞态**：`shouldSpawnTask` 用 `existing.project` 在 transaction 之外解析 `executionProject`，理论上 leaver 把 `project.collaborationId` 置 null 的瞬间触发，task 就会绑到一个已经不属于 collab 的 project。窗口很小，需要时把 `executionProject` 重新在事务里取一次。
- **跨成员的 prompt-injection**：collaborator 把恶意指令塞到 issue title / description，issue 进入 doing 时会作为 `initialMessageContent` 发给 owner 自己 daemon 上的 AI。MVP 接受这个信任边界（"协作是自愿邀请的小群体"），需要时再加一层 sanitizer 或在前端展示原文 + 提示。
