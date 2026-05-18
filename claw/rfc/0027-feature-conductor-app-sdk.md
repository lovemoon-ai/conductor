# 0027 Conductor App SDK

## Status

Proposed

## Owner

TBD

## Date

2026-05-17

## Summary

发一个 npm 包 `@conductor/app-sdk`（目录 `modules/app-sdk`），让第三方项目能轻量接入 Conductor。包内两个对外入口：

- `@conductor/app-sdk/server`：Node 库，给第三方**后端**用。覆盖三个最小动作：
  1. **第一次关联**：在用户的 Conductor 下找/建一个 project。
  2. **建 task**：在该 project 下起一个 AI task。
  3. **聊天**：往 task 发消息、订阅 AI 回复事件。
- `@conductor/app-sdk/react`：把 `web/src/features/chat` 的聊天框抽出来，第三方**前端**直接 `<ChatView />` 复用，含 desktop / mobile 自适应。

通过 `package.json` 的 subpath exports 单包分发；服务端代码不污染浏览器 bundle，反之亦然。

## Context

- Conductor 后端已经有完整 REST 接口（`/api/projects`、`/api/tasks`、`/api/tasks/[taskId]/messages`、`/api/tasks/[taskId]/interrupt`）和 `/ws/app` WebSocket（`web/server.ts` + `app-gateway.ts`），鉴权走 `Authorization: Bearer <token>`（token 由 `POST /api/auth/tokens` 签发）。
- 聊天 UI 已经沉淀在 `web/src/features/chat/`：`ChatView.tsx`（889 行）+ `MessageBubble.tsx` + `MessageInput.tsx` + zustand stores，Tailwind v4 + CSS 变量主题，desktop / mobile 用响应式 className 切。
- 当前耦合点：`features/chat/store.ts` 直接 `import { getApiClient } from '@/shared/api/client'`；类型从 `@/shared/types` 来。抽包必须先把这层解耦。
- 现有 `modules/conductor-sdk` 是 **daemon-side**（注册 `agent_host`、收 `stop_task`），方向相反不能复用。

## Goals

- 第三方在自家后端写**不超过 30 行**就能完成"关联 → 起 task → 发消息 → 收流式回复"。
- 第三方在自家前端写**不超过 10 行 JSX**就能把 Conductor 聊天框嵌进去。
- 复用现有后端接口，**不改 schema、不引入新 token 类型**。
- 抽包不破坏主站行为（`web/src/features/chat/components/ChatView.test.tsx` 1423 行测试必过）。

## Non-Goals

- **不**直连 daemon（所有调用过 Conductor Web 后端）。
- **不**引入 token 范围隔离 / scoped token / Connected Apps 设置面板等鉴权升级——v1 用现有 user-level token，沿用现有信任模型（"app 持有 token = 等同用户操作"）。可见性增强放 follow-up RFC。
- **不**做 Vue / Svelte / Web Component 版本聊天框；只发 React。
- **不**做 OAuth flow；token 沿用"用户在主站手动创建 → 复制粘贴到第三方配置"的现有 UX。
- **不**做大量 BFF 路由 helper（Express / Fastify adapter）；第三方自己写薄的 pass-through 即可。
- **不**对聊天框做视觉重设计；本期只做接口解耦 + 物理外移。

## Proposed Design

### 1. 包结构

```
modules/app-sdk/
  package.json                       # exports: . / ./server / ./react / ./react/styles.css
  tsconfig.json                      # project references → server / react / types 三个子 config
  src/
    types/                           # 纯类型（被三段共享、根入口 re-export）
      task.ts message.ts events.ts adapter.ts errors.ts
      index.ts
    index.ts                         # 包根：re-export types + SDK_VERSION
    server/                          # Node only
      index.ts                       # connect() / AppClient
      client.ts
      projects.ts                    # bind() / create() / get()
      tasks.ts                       # create() / get() / list()
      messages.ts                    # send() / history()
      events.ts                      # subscribe() over /ws/app（+ SSE fallback）
      stream.ts                      # streamReply(): AsyncIterable wrapper
    react/                           # 浏览器 / React only
      index.ts                       # ChatView 等导出
      ChatView.tsx
      components/                    # 从 web/src/features/chat 抽出
        MessageList.tsx
        MessageBubble.tsx
        MessageInput.tsx
        RuntimeStatusBar.tsx
        MarkdownRenderer.tsx
      adapter/
        types.ts                     # ChatAdapter 接口
        rest-adapter.ts              # 默认 fetch + SSE 实现
        mock-adapter.ts              # 测试用
      store/                         # zustand per-instance
        chat-store.ts runtime-store.ts
      styles.css                     # 预编译 Tailwind
```

`package.json exports` 关键片段：

```jsonc
{
  "exports": {
    ".":                       { "types": "./dist/types/index.d.ts", "import": "./dist/types/index.js" },
    "./server":                { "types": "./dist/server/index.d.ts", "node": "./dist/server/index.js", "default": "./dist/server/index.js" },
    "./react":                 { "types": "./dist/react/index.d.ts",  "browser": "./dist/react/index.js", "default": "./dist/react/index.js", "react-server": null },
    "./react/styles.css":      "./dist/react/styles.css"
  },
  "peerDependencies":     { "react": ">=16.8", "react-dom": ">=16.8" },
  "peerDependenciesMeta": { "react": { "optional": true }, "react-dom": { "optional": true } }
}
```

`react-server: null` 阻止有人把 `<ChatView>` 错放进 React Server Component。`peerDependenciesMeta.optional` 让纯服务端用户不被 React 缺失警告打扰。

### 2. Server API

```ts
import { connect } from "@conductor/app-sdk/server";

const client = await connect({
  baseUrl: "https://conductor.example.com",
  bearerToken: process.env.CONDUCTOR_TOKEN!,   // 用户在 Conductor 主站签发，粘贴进来
});

// 第一次关联：找或建 project，幂等
const project = await client.projects.bind({
  name: "Acme Dashboard",
  daemonHost: "duino-mbp",                     // 用户告诉 app 的 daemon 名
  workspacePath: "/Users/me/work/acme",
});
// → { id, name, daemonHost, workspacePath, createdByApp: true }
// caller 持久化 project.id

// 创建 task
const task = await client.tasks.create({
  projectId: project.id,
  title: "Investigate billing anomaly",
  initialMessage: "Look at the last 24h of charges and flag outliers.",
});

// 发消息（带自动 clientRequestId 幂等）
await client.tasks.sendMessage(task.id, "drill into the top one");

// 订阅事件 / 流式拿回复（AsyncIterable）
for await (const evt of client.tasks.subscribe(task.id)) {
  if (evt.type === "message_appended") writeToBffStream(evt.message);
  if (evt.type === "runtime_status")   updateStatusBadge(evt.status);
  if (evt.type === "task_finished")    break;
}
```

#### 协议映射（全部走现有接口，**零后端改动**）

| SDK 调用 | 后端 |
|---|---|
| `projects.bind({ name, daemonHost, workspacePath })` | `GET /api/projects/match-path` 找；找不到 `POST /api/projects` 建。`metadata.audit.createdByApp = { tokenName }` 自动注入（用现有 audit infrastructure，零 schema 改动） |
| `tasks.create(...)` | `POST /api/tasks` |
| `tasks.sendMessage(id, content)` | `POST /api/tasks/[id]/messages`（带 `client_request_id`） |
| `tasks.history(id, opts)` | `GET /api/tasks/[id]/messages?pagination=1` |
| `tasks.interrupt(id, opts)` | `POST /api/tasks/[id]/interrupt` |
| `tasks.subscribe(id)` | `/ws/app` 长连接；自动重连 + 增量回放 |

#### `projects.bind()` 的关联流程语义

1. 调用方传 `daemonHost + workspacePath`。
2. SDK 调 `/api/projects/match-path` 查是否已有匹配 project。
3. 有 → 直接返回。无 → 调 `/api/projects` POST 建一个新 project。
4. 不论新建还是复用，都返回同一形状的 project 对象。
5. 调用方拿到 `project.id` 后**自行持久化**（env / db / config）；后续 SDK 调用不再需要重复 bind。

> 这是个"幂等关联"接口，不引入新 token 类型，不引入新 schema——只是封装"先 match 后 create"两步并加一行 audit 标记。

### 3. Widget + ChatAdapter

```tsx
import { ChatView, createRestAdapter } from "@conductor/app-sdk/react";
import "@conductor/app-sdk/react/styles.css";

const adapter = createRestAdapter({
  baseUrl: "/api/conductor",          // 指向第三方自家 BFF 的 pass-through 路径
  authToken: () => userJwt,           // 第三方自家的鉴权（不是 Conductor 的 token）
});

export function MyChatPage({ taskId }: { taskId: string }) {
  return (
    <ChatView
      taskId={taskId}
      adapter={adapter}
      labels={{ statusThinking: "AI 正在思考…", interrupt: "停止" }}
      theme={{ accent: "#e4572e" }}
    />
  );
}
```

#### `ChatAdapter` 接口（widget ↔ 宿主后端的唯一契约）

```ts
export interface ChatAdapter {
  fetchHistory(taskId, opts?: { beforeId?; limit?; signal? }): Promise<{
    messages: Message[];
    hasMoreBefore: boolean;
    oldestMessageId: string | null;
  }>;
  subscribe(taskId, handler: (e: ChatEvent) => void): { unsubscribe(): void };
  sendMessage(taskId, input: SendMessageInput): Promise<Message>;
  interrupt(taskId, opts: { targetReplyTo: string }): Promise<void>;
}

export type ChatEvent =
  | { type: 'message_appended'; message: Message }
  | { type: 'message_updated';  message: Message }
  | { type: 'runtime_status';   status: RuntimeStatus }
  | { type: 'task_finished';    taskId: string }
  | { type: 'task_failed';      taskId: string; error: { code: string; message: string } }
  | { type: 'connection_state'; state: 'connected' | 'reconnecting' | 'offline' };
```

第三方有两种典型用法：

- **A. 用默认 `createRestAdapter`**：自家 BFF 提供 6 个 REST 路径（GET messages / POST messages / POST interrupt / GET stream as SSE 等），路径形状跟 SDK 期望对上，BFF 内部用 `@conductor/app-sdk/server` 转发到 Conductor。
- **B. 自实现 `ChatAdapter`**：不喜欢默认 wire format？直接 `class MyAdapter implements ChatAdapter { ... }`，走自家 GraphQL / tRPC / 任何协议——widget 只跟接口打交道，不绑死 wire。

### 4. Widget 抽包策略（两阶段，绝不动主站行为）

1. **阶段 A：内部 adapter 化（仍在 web 仓库内）**
   - 把 `features/chat/store.ts` 的 `getApiClient()` 调用收敛到一个内部 `defaultChatAdapter`。
   - `ChatView` / `MessageList` / `MessageInput` 加一层 `useChatAdapter()`，默认值就是 `defaultChatAdapter`。
   - 跑全套 web 测试（含 `ChatView.test.tsx`），行为不变。
2. **阶段 B：物理外移到 `modules/app-sdk/src/react/`**
   - 复制组件 + store + adapter 接口。
   - `features/chat` 改为 re-export `@conductor/app-sdk/react`。
   - 再跑全套 web 测试，必过。

主站从此 dogfood 自己的外部 widget；任何破坏 widget API 的改动会先在主站炸出来。

### 5. 鉴权与可见性

- **Token**：用户在主站 Settings → API Tokens 签发一个普通 token，复制粘贴到第三方 BFF 的环境变量。沿用现有 UX，**不引入新 token 类型**。
- **信任边界**：token 持有方 = 用户。这是 v1 的明确简化——app 拿到 token 就拥有用户全部权限。第三方应该把 token 当 secret 对待（README 强制要求）。
- **可见性提示**：`projects.bind()` 在建出 project 时往 `metadata.audit.createdByApp = { tokenName }` 写一条记录（用现有 audit infrastructure，零 schema 改动）。主站 UI 后续可以基于这个字段做"标识 app 创建的 project"的小 chip，但**本 RFC 不要求主站 UI 改动**——纯审计字段，将来想做隔离时这个字段是入口。
- **token 撤销**：用户在主站 Tokens 设置页删 token（现有 UX），app 后续所有调用 401，BFF 负责给前端友好提示。

### 6. 流式传输：WS over Node, SSE to browser

- `@conductor/app-sdk/server` 跟 Conductor 后端之间走 `/ws/app` WebSocket（Node 端 ws 库稳定，已被 conductor-sdk 验证）。
- 第三方 BFF 到自家前端 widget 之间，**默认走 SSE**（`text/event-stream`）：Next.js App Router 原生支持、跨代理友好、不用 custom server。
- 默认 `createRestAdapter` 的 `subscribe()` 在 widget 端就是 `new EventSource(...)`。
- 想要真 WS 的第三方可以传 `webSocketUrl` 覆盖默认行为。

第三方 BFF 写 SSE 桥接的最小代码（Next.js App Router）：

```ts
// app/api/conductor/tasks/[taskId]/events/route.ts
export async function GET(req, { params }) {
  const stream = new ReadableStream({
    async start(controller) {
      for await (const evt of client.tasks.subscribe(params.taskId)) {
        controller.enqueue(`data: ${JSON.stringify(evt)}\n\n`);
      }
      controller.close();
    }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}
```

10 行 BFF 代码完成 widget ↔ Conductor 的事件桥。

### 7. 测试

- `cd modules/app-sdk && pnpm test` 一条命令，vitest projects 分两组：
  - node 环境跑 server / adapter 单测 + msw 契约测试。
  - jsdom 环境跑 react 组件 + mock-adapter 集成测试。
- 主站 `cd web && pnpm test`：含 `ChatView.test.tsx` 1423 行回归——抽包前后行为必须一致，是抽包过程的硬门槛。

## Risks

- **token 持有等于账号持有**：第三方 BFF 如果泄漏 token，攻击者可以操作用户所有 project。**缓解**：README 硬要求 server-only；可见性 chip 让用户事后能识别异常活动；scoped token 留独立 follow-up RFC。
- **抽包破坏主站**：1423 行测试是守门员；§4 两阶段策略保证可回滚。
- **subpath exports 配错让浏览器吃 Node 代码**：CI 加一条 bundle 烟测（最小 Vite 工程只 import `/react`，断言 bundle 不含 `node:` / `fs` / `crypto.randomBytes`）。
- **WS over App Router 是真实痛点**：默认 SSE 绕开；想用 WS 的接入方走 custom server.ts，文档明示。
- **`projects.bind()` 幂等性依赖于 `match-path`**：现有 `/api/projects/match-path` 用 daemonHost + workspacePath 做主键，已被主站验证过；SDK 直接复用。

## Rollout

1. **M0**：建 `modules/app-sdk` 单包骨架（package.json exports + tsup + 三个 tsconfig + vitest projects + bundle 烟测），pnpm workspace 接入。
2. **M1**：`/server` 全功能（projects.bind / tasks 全套 / subscribe / streamReply）+ 单测 + msw 契约。发 0.1.0。
3. **M2**：`/react` widget 抽包，按 §4 两阶段走。发 0.2.0。
4. **M3**：`modules/app-sdk/examples/02_bff` demo（Next.js BFF + React 页面，端到端"关联 → 起 task → 聊天 → 中断"）+ `modules/app-sdk/examples/01_example` 纯 Node CLI demo + README。发 1.0.0。

兼容性：1.x 期间 `ChatAdapter` / `AppClient` 方法签名 / 包根类型冻结，破坏性变更走 major。

## Acceptance

- `cd modules/app-sdk && pnpm test` 全绿（node + jsdom 两组）。
- `cd modules/app-sdk && pnpm test:bundle` 通过（浏览器 bundle 不含 Node 符号）。
- `cd web && pnpm test` 全绿，主站切到 `@conductor/app-sdk/react` 后行为零回归。
- `modules/app-sdk/examples/02_bff` 能本地跑通端到端，业务代码 ≤ 100 行（BFF ≤ 30 行 + 前端 ≤ 10 行 JSX + 配置）；`modules/app-sdk/examples/01_example` 纯 Node CLI 业务代码 ≤ 35 行。
- 后端 REST / `/ws/app` 在本 RFC 周期内零改动。

## Open Questions

1. **`projects.bind()` 当 daemon 离线时**：返回带 `warning` 的 project 对象，还是 422 阻塞？倾向前者（用户可能在 daemon 没开时配 app）。
2. **widget i18n**：`labels` prop 默认英文，第三方按字符串覆盖；够不够？需要正式 i18n provider 吗？倾向 v1 用 `labels` prop，正式 provider 看反馈。
3. **`subscribe()` AsyncIterable vs ReadableStream**：倾向 AsyncIterable + `toReadableStream()` 适配器。
4. **`createByApp` audit 字段**是否需要在主站 UI 渲染一个小 chip？倾向 v1 不做，纯审计字段，等用户反馈再加。
