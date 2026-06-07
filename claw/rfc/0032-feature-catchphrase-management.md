# 0032 口头禅（Catchphrase）管理

## Status

Proposed

## Owner

dang217

## Date

2026-06-06

## Summary

在 web 端 Settings 增加一个全局口头禅（Catchphrase）管理面板，允许用户对常说给 AI 的短语（例如「请用中文回答」「按 RFC 模板写文档」「先给我实现方案，再写代码」等）进行增删改查。该列表对当前用户全局有效、所有项目共用。在聊天输入框中通过**「空输入框双击」**这唯一一个手势触发口头禅选择浮层：单击条目「填入」输入框（可继续编辑），双击条目「直接发送」到当前 task 的会话流。输入框非空时双击不做任何处理（既不弹浮层，也不需要专用按钮入口）。

## Context

- Conductor 是 AI 协作 / 任务执行平台，用户在 `MessageInput`（`web/src/features/chat/components/MessageInput.tsx`）中向 AI 发送 prompt。当前已有 ↑/↓ 翻历史的能力，但历史与具体 task 强相关（来自 `messagesByTask`），无法跨任务、跨项目复用「这一次跟所有 AI 都想强调的口头禅」。
- 经常会有一类极短的「重复输入」：要求语言、风格、产出形式、是否先讨论再实现等。用户希望一次保存、永远复用，类似于 IDE 的 snippet / 输入法的自定义短语。
- 已有的用户级偏好通过 `web/prisma/schema.prisma` 中的 `UserPreference(userId, key, value)` 模型 + `web/src/lib/user-preferences.ts` 实现（参考 task-list 偏好）。这是一个为「单 key 单 value」结构设计的 KV 存储，单条 value 可以承载 JSON。本 RFC 需要决定：把口头禅当成「一条 JSON 数组」存进 UserPreference，还是「一行一条」存进一个新表。
- Settings 入口位于 `web/src/app/app/settings/page.tsx`（`Connected Daemons / Build Info / Session` 三块卡片），新功能将作为一张新的 section 卡片挂入。
- 现有交互：输入框单击聚焦，双击在有内容时会被浏览器解释为「选词」。本设计**只在空输入框上**捕获双击 —— 此时本来就没有可选的字，浏览器原生「选词」行为不会被破坏，也无需常驻按钮做替代入口（详见「双击交互」一节）。

## Goals

- 用户能够在 Settings 页面增、删、改、查自己的口头禅列表（用户范围全局，跨项目共用）。
- **空**输入框双击可弹出口头禅浮层；单击条目填入输入框，双击条目直接发送到当前 task。**非空输入框双击不做任何处理**（既不弹浮层，也不抢占浏览器原生行为）。
- 顺序可由用户调整（拖拽或简单的上移/下移按钮），最常用的放最前。
- 数据落库到服务端，跨设备、跨浏览器同步；离线/未鉴权时降级为本地草稿能力（可选）。
- 后端 API 复用现有鉴权 (`getAuthUser`) 与 realtime 广播 (`realtimeHub.broadcastToUser`) 机制，让多端实时同步。

## Non-Goals

- 不做团队/项目级共享（先保「自己用」，团队共享留作后续 RFC）。
- 不做按场景/项目自动联想（不是 prompt 推荐系统，纯手动短语库）。
- 不做模板变量、占位符渲染（不引入 `{{var}}`，避免变成迷你 prompt 模板引擎）。
- 不替代 ↑/↓ 历史浏览能力，二者并存。
- CLI / fire 端不直接读写口头禅（聊天主入口仍是 web）。

## Options Considered

### Option A：把所有口头禅塞进 `UserPreference` 的一条 JSON

- key = `catchphrases`，value = `JSON.stringify([{id, text, order}, ...])`
- Pros
  - 零 DB schema 变更，复用 `web/src/lib/user-preferences.ts` 的 `getXxx/setXxx` 模式。
  - 写入是单行 upsert，事务简单；不会出现「半条数据写一半」。
  - 读时一次拿全部，前端做内存增删改后整体 PATCH 回服务端。
- Cons
  - 没有按条记录的 `createdAt/updatedAt`，无法做「最近编辑」排序。
  - 多端并发编辑会「最后写入覆盖」，没有 per-row 冲突合并。
  - JSON 字段无法走 SQL 索引或全文检索（在条目数 < 几百时无所谓）。

### Option B：新增独立表 `UserCatchphrase`

- 字段：`id, userId, text, sortOrder, createdAt, updatedAt`
- Pros
  - 与现有 `Project`、`Task` 等业务实体一致的「一行一条」语义。
  - 可以做按 row 的乐观锁、批量重排、未来加 `lastUsedAt` 做「最近使用」排序。
  - 删除单条不需要先读再写。
- Cons
  - 多一次 schema 迁移；Prisma 在 SQLite 上加表 + `pnpm db:push` 流程必须执行。
  - 重排（sortOrder）需要批量 update，比 Option A 的「整组 JSON 改写」实现更繁琐。

### Option C：纯前端 + `localStorage`

- Pros
  - 最低成本，立刻可用。
- Cons
  - 换设备 / 清缓存即丢失，违背「全局共用」诉求。
  - 多端无法同步。**否决**。

**推荐：Option B**。条目可能上百，独立表换来排序、最近使用、未来扩展的从容；schema 已经有非常成熟的迁移流程（参考 `claw/sop/06_release.md`），新增一张小表的成本可控。下文按 Option B 设计。

## Proposed Design

### 1. 数据模型

在 `web/prisma/schema.prisma`（以及对应的 `schema.postgres.prisma`）新增：

```prisma
model UserCatchphrase {
  id        String   @id @default(uuid())
  userId    String   @map("user_id")
  text      String   // 口头禅原文，UTF-8；前端做 trim + 长度限制
  sortOrder Int      @default(0) @map("sort_order")
  lastUsedAt DateTime? @map("last_used_at")  // 用于将来「最近使用」排序
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, sortOrder])
  @@map("user_catchphrases")
}
```

并在 `User` 上加 `catchphrases UserCatchphrase[]` 反向关系。

字段约束（前端 + Zod 后端均要校验）：

- `text`：trim 后非空，最大 500 字符（覆盖中等长度的指令，足够）。
- 单用户总条数上限：100 条（防止误输入造成的滥用）。
- `sortOrder`：整数；新建条目默认追加到末尾（`max(sortOrder) + 1`）。

### 2. 后端 API

新增 RESTful 子树 `web/src/app/api/user-preferences/catchphrases/`（保留在 `user-preferences` 命名空间下，因为属于「用户级偏好」类别）：

| Method | Path                                            | 用途                  |
| ------ | ----------------------------------------------- | --------------------- |
| GET    | `/api/user-preferences/catchphrases`            | 拉取当前用户全部口头禅 |
| POST   | `/api/user-preferences/catchphrases`            | 新建一条               |
| PATCH  | `/api/user-preferences/catchphrases/:id`        | 修改一条的 `text`      |
| DELETE | `/api/user-preferences/catchphrases/:id`        | 删除一条               |
| PUT    | `/api/user-preferences/catchphrases/reorder`    | 批量重排 (`[{id, sortOrder}]`) |
| POST   | `/api/user-preferences/catchphrases/:id/touch`  | 仅更新 `lastUsedAt`，用于「最近使用」 |

实现要点：

- 所有路由复用 `getAuthUser(request)`，未登录返回 401。
- 使用 Zod 校验 body（参考 CLAUDE.md「Validate inputs with Zod schemas」）。
- 业务逻辑放 `web/src/lib/user-catchphrases.ts`，仿照 `user-preferences.ts` 的模式：导出 `listCatchphrases / createCatchphrase / updateCatchphrase / deleteCatchphrase / reorderCatchphrases / touchCatchphrase`。
- 每次写操作完成后通过 `realtimeHub.broadcastToUser(user.id, { type: 'user_catchphrase_update', payload: { catchphrases } })` 推送新快照，让其它打开的 web 端实时刷新。
- 响应统一格式：`{ catchphrases: [{ id, text, sortOrder, lastUsedAt, updatedAt }] }`。

### 3. 前端状态层

新增 `web/src/features/catchphrases/`：

- `store.ts`：zustand store（仿照 `features/user-preferences/store.ts` 的乐观更新 + 失败回滚 + sequence 防覆盖），暴露：
  - `catchphrases`, `hydrated`, `loading`, `error`
  - `hydrate()`, `create(text)`, `update(id, text)`, `remove(id)`, `reorder(ids)`, `touch(id)`
- `index.ts`：barrel 导出 + `useCatchphraseShortcuts()` hook（供 `MessageInput` 调用）。
- `components/CatchphrasePopover.tsx`：在输入框上方显示的浮层，单击 = 填入，双击 = 直接发送。
- `components/CatchphraseSettingsCard.tsx`：在 `web/src/app/app/settings/page.tsx` 中作为一张新卡片渲染。

`store.ts` 监听 realtime 推送：在已有的 realtime 客户端订阅（参考 `features/realtime` 与 `MessageBubble`/`task-list` 中的接入方式）中加入 `user_catchphrase_update`，收到后调用 `applyCatchphrases(payload.catchphrases)`，与 `applyTaskListPreferences` 完全同构。

### 4. Settings 面板（增删改查 UI）

在 `web/src/app/app/settings/page.tsx` 新增一张卡片：

```text
[ 口头禅 / Catchphrases ]
[ + 新增 ]
┌─────────────────────────────────────────────────┐
│ ⠿  请用中文回答              [ 编辑 ] [ 删除 ]  │
│ ⠿  先给方案，再写代码          [ 编辑 ] [ 删除 ]  │
│ ⠿  小步提交，每步可回滚        [ 编辑 ] [ 删除 ]  │
└─────────────────────────────────────────────────┘
```

行为：

- 「+ 新增」打开一个内联输入框，回车 / 点击「保存」即创建。
- 「编辑」原地变成 textarea，回车保存、Esc 取消。
- 「删除」二次确认（轻量 inline confirm，不上 modal）。
- 左侧 `⠿` 可拖拽重排（首版可以先做 ↑/↓ 按钮，拖拽放第二个迭代）。
- 空态展示提示语：「还没有口头禅，新建一条试试」。
- 卡片顶部加一句固定 hint：「**Tip**: 在聊天输入框为空时双击，可呼出口头禅列表」，承担用户对触发手势的学习成本。

### 5. 聊天输入框双击交互

修改 `web/src/features/chat/components/MessageInput.tsx`：

- 在 textarea 上挂 `onDoubleClick` 监听。**唯一触发条件**：`content.trim() === '' && !isComposingRef.current` —— 输入框为空且不在 IME 输入态。此时空 textarea 上本来就没有可选词，浏览器原生「双击选词」不会被破坏。
- **非空场景一律不响应**：handler 第一行直接 `return`，不 `preventDefault`，不弹浮层，不放任何替代入口按钮。这是有意保留浏览器原生「双击 = 选词」的工作流。
- popover 显示当前 store 的 `catchphrases` 列表（按 `sortOrder` 升序；后续可加「最近使用置顶」开关）。空列表态显示 hint：「还没有口头禅，去 Settings 添加几条」+ 一个到 `/app/settings` 的链接。
- 列表项交互：
  - **单击**：把 `text` 写入 textarea（空 textarea 直接替换即可），关闭 popover，聚焦输入框、光标置末尾，调用 `touch(id)`。
  - **双击**：直接 `submitContent(text)`（复用 `MessageInput` 现有的 `submitContent`），关闭 popover，调用 `touch(id)`。
- 关闭：点击空白处、Esc、用户开始打字（textarea 变为非空时自动收起，避免遮挡）。
- popover 在键盘上支持 ↑/↓ 移动高亮、Enter = 填入、Shift+Enter = 直接发送（让重度键盘用户也能不用鼠标）。
- 因为触发手势是「空框双击」、不存在歧义，所以 UI 上不需要常驻按钮、也不需要在输入框旁边写说明文字 —— 学习成本由 Settings 卡片中的一句 hint 承担（见下一节）。

### 6. 设置入口的导航记忆

`SettingsPage` 已经在用 `useSettingsNavStore.setLastPath(SETTINGS_ROOT_PATH)`，新卡片就放在主 `/app/settings` 上、不开子路由，自然继承现有导航记忆。

### 7. 测试

按 CLAUDE.md「Every feature needs at least one API route test plus either a widget or SDK test」的要求：

- `web/src/app/api/user-preferences/catchphrases/route.test.ts`：覆盖 GET / POST / 鉴权失败 / 上限 100 / text 越界 / 多端 realtime 广播。
- `web/src/app/api/user-preferences/catchphrases/[id]/route.test.ts`：PATCH / DELETE / 跨用户隔离（A 用户不能改 B 的）。
- `web/src/features/catchphrases/store.test.ts`：乐观更新 + 失败回滚 + sequence 防覆盖。
- `web/src/features/chat/components/MessageInput.test.tsx`：补充以下用例 ——
  - 空 textarea 双击 → popover 打开
  - **非空 textarea 双击 → 浮层不打开、事件不被 `preventDefault`**（用户原生选词仍可工作）
  - 列表项单击 → 文本填入、popover 关闭、focus 回到输入框
  - 列表项双击 → 调用 `submitContent` 立即发送
  - IME composition 中双击 → 不触发
  - 用户在 popover 打开期间开始打字（textarea 变为非空）→ popover 自动关闭
- `web/src/app/app/settings/page.test.tsx`：渲染新卡片，新增 / 编辑 / 删除流程的快照。

跑测命令：`cd web && pnpm test`。

## Risks

- **双击手势被发现率低**：唯一入口是「空输入框双击」，没有按钮、没有右键菜单。靠 Settings 卡片顶部那行 Tip 承担学习成本；如果上线后数据显示发现率不达预期，再补充入口（例如首次打开聊天页时一次性 onboarding 浮层），但不在首版引入额外 UI 元素。
- **双击与浏览器原生「选词」行为冲突**：通过「仅在 `content.trim() === ''` 时响应」规避 —— 空 textarea 上本来就无词可选，浏览器原生行为不受影响；非空场景我们的 handler 第一行就 return，完全不接管事件。
- **多端并发编辑**：A 端编辑，B 端同时拖拽重排；用 realtime 广播完整快照（不是 diff）即可让后写者刷掉前写者的本地草稿；编辑窗口内做「服务端 updatedAt 比本地新则提示刷新」的轻量冲突感知。
- **schema 迁移遗漏**：新表必须在 `schema.prisma` 与 `schema.postgres.prisma` 同步落地，并在 PR 描述里按 CLAUDE.md「Flag schema changes」要求高亮，让部署方先跑 `pnpm db:push`。
- **超长 text 拖慢列表渲染**：500 字符上限 + 列表行 `line-clamp-2`，详细查看进入编辑态。
- **滥用做小本子**：用户可能塞入 50+ 条长指令导致 popover 卡顿；条数上限 100、单条 500 字符已经在容量内。

## Rollout

1. **Schema**：`web/prisma/schema.prisma` + `web/prisma/schema.postgres.prisma` 新增 `UserCatchphrase`；本地 `cd web && pnpm db:push` 验证；生成 migration 文件提交到 `web/prisma/migrations/`。
2. **后端**：`web/src/lib/user-catchphrases.ts` + `web/src/app/api/user-preferences/catchphrases/**` 路由 + 测试。
3. **realtime 类型**：在 `web/src/lib/realtime/` 的事件类型 union 中加入 `user_catchphrase_update`。
4. **前端 store**：`web/src/features/catchphrases/` 完成后接 realtime。
5. **Settings UI**：`web/src/app/app/settings/page.tsx` 接入 `CatchphraseSettingsCard`。
6. **MessageInput**：`web/src/features/chat/components/MessageInput.tsx` 接入 popover + 💬 按钮，并写单元测试。
7. **E2E 验证**：按 CLAUDE.md「E2E Test in Local Development」流程：`make run-dev` 起服务，浏览器 MCP 验证「新建口头禅 → 输入框双击 → 单击填入 / 双击发送 → 跨刷新仍在」。
8. **PR**：摘要中明确「新增 UserCatchphrase 表，需要部署侧执行 `pnpm db:push`」，附 UI 截图与 `cd web && pnpm test` 输出。

向后兼容：纯新增能力，无既有用户行为受损；旧客户端不感知，新表对它们就是空集。

## Acceptance

- 用户能在 `/app/settings` 创建、编辑、删除、重排口头禅，且刷新页面后保留。
- 同账号两个浏览器同时打开 Settings：一端的写入在 ≤ 2 秒内通过 realtime 出现在另一端，无需手动刷新。
- 在 `/app/projects/<id>` 进入某 task 的聊天页：**空**输入框双击弹出 popover；单击条目，文本进入输入框、光标定位末尾、popover 关闭；双击条目，消息被立即发送、出现在聊天流里。
- **在有内容的输入框上双击仍然是浏览器原生选词**，handler 立即 return、不调 `preventDefault`、不弹浮层；除此之外无任何专用入口按钮。
- 中文输入法（IME composition）进行中即便 textarea 暂时显示为空也不会误触发 popover。
- popover 打开期间用户开始打字，textarea 一旦非空，popover 立即自动关闭，不遮挡输入。
- `cd web && pnpm test` 全绿；新增的 5 个测试文件全部通过。
- 单用户 100 条上限、单条 500 字符上限在前后端均生效，越界时给出明确错误提示。

## Open Questions

- ~~单击「填入」时，textarea 已有内容应该「替换」还是「在光标处插入」？~~ → 已不存在：popover 的触发条件保证打开时 textarea 一定是空的，「填入 = 直接写入」即可，无歧义。
- 是否在 popover 顶部加搜索框？条数上限 100 时未必必要，但用户可能希望按关键字过滤；建议第二个迭代加。
- 「最近使用」排序与「手动顺序」排序如何切换？建议存一个用户偏好 `catchphrasePopoverSort: 'manual' | 'recent'`，默认 `manual`，复用现有 `UserPreference` KV。
- 是否需要导入/导出（JSON）？方便用户在多账号间迁移；如果做，放进 Settings 卡片的「⋯」菜单。
- 是否需要将口头禅同步给 fire / CLI（例如 `conductor fire` 时 `--catchphrase=<id>` 注入）？本 RFC 暂不覆盖，待 CLI 端有明确诉求再开新 RFC。
