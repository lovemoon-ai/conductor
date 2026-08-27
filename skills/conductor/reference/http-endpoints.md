# Conductor 附加 HTTP 接口（搜索 / 交接摘要 / Agent 调度管控 / 运行时预检）

这一组能力没有独立的 `conductor <sub>` 命令，主要通过 HTTP API 使用（少数是自动行为）。面向两类调用者：

1. **AI Agent**：在 `conductor fire` 里跑的 agent，环境里有 `CONDUCTOR_BACKEND_URL`、`CONDUCTOR_AGENT_TOKEN`、`CONDUCTOR_TASK_ID`，可直接 `curl` 调这些接口。
2. **人类 / 脚本**：用 web 登录 token 或 `~/.conductor/config.yaml` 的 `agent_token` 作 `Authorization: Bearer <token>`。

统一鉴权：`Authorization: Bearer <token>`。Agent 侧一般：

```bash
AUTH="Authorization: Bearer $CONDUCTOR_AGENT_TOKEN"
BASE="$CONDUCTOR_BACKEND_URL"   # 例如 http://127.0.0.1:6152
```

---

## 1. 全历史搜索 `GET /api/search`

跨**当前用户所有任务**的所有消息做全文搜索（owner 维度；不含协作项目，与 app 内任务列表口径一致）。

```bash
curl -s -H "$AUTH" "$BASE/api/search?q=diffusion%20schedule&limit=30"
```

- `q` 必填；`limit` 可选（默认 30，上限 100）。空 `q` 直接返回空结果。
- 返回：

```json
{
  "query": "diffusion schedule",
  "backend": "fts",
  "hits": [
    { "taskId": "...", "taskTitle": "...", "messageId": "...", "role": "assistant",
      "snippet": "…the [diffusion] [schedule] is…", "createdAt": "2026-05-01T00:00:00.000Z" }
  ]
}
```

- `backend`：`fts` 表示走 SQLite FTS5 索引（默认方言，支持前缀 type-ahead，如 `zephyr` 命中 `zephyrquux`）；`like` 表示降级为大小写不敏感的 `LIKE` 扫描（FTS5 不可用或非 SQLite 方言时）。
- `snippet` 里 `[...]` 包住的是命中词（前端据此高亮）。
- 索引在服务启动时建好并由触发器实时增量；无需手动维护。
- **前端入口**：Settings 页的 "Search" 卡片 → `/app/search`（边打边搜，按任务分组，可点进任务）。

## 2. 交接摘要 `POST /api/tasks/{taskId}/digest`

把一个任务的近期对话，用 LLM 摘要成**干净的 Markdown 交接文档**（目标/已完成/当前状态/未决/下一步/关键文件），用于把任务交接给另一个任务、另一个人、或另一个 backend——而不是贴一坨原始记录。

```bash
curl -s -X POST -H "$AUTH" "$BASE/api/tasks/$CONDUCTOR_TASK_ID/digest"
```

- 返回 `{ ok, task_id, digest_markdown, summarizer, source }`。
- **前置**：需配 `GLM_API_KEY`（复用日报那套 GLM 配置）。可选：`GLM_HANDOFF_DIGEST_MODEL`（默认 `glm-5.2`）、`GLM_HANDOFF_DIGEST_TIMEOUT_MS`（默认 30000）、`GLM_HANDOFF_DIGEST_MAX_CHARS`（源包裁剪上限）。
- **显式失败**（不会拿原始记录冒充摘要）：
  - 没配 key → `503 { "error": "digest_failed", "reason": "missing_api_key" }`
  - LLM 报错/空响应 → `502 digest_failed`
  - 任务无消息 → `409 empty_task`
  - 任务不属于当前用户 → `404`
- 拿到 `digest_markdown` 后，投递到目标任务：`conductor task insert <targetTaskId> "<markdown>"`（或 `POST /api/tasks/{target}/insert`）。

## 3. Agent 调度访问控制（`agent_schedule_access`）

`conductor task schedule create|list|delete`（见 `entity-commands.md` §8）让 agent 能给任务自排延时/循环消息。这里的每-任务开关控制**允许 agent 做到什么程度**：

| 值 | 含义 |
|---|---|
| `full`（默认） | agent 可 list / create / delete |
| `read_only` | agent 只能 list / get |
| `blocked` | agent 完全不能碰调度（连 list 都 403） |

读当前值：

```bash
curl -s -H "$AUTH" "$BASE/api/tasks/$TASK/agent-schedule-access"
# -> { "task_id": "...", "access": "full" }
```

设置（两种等价入口）：

```bash
# 专用端点
curl -s -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"access":"blocked"}' "$BASE/api/tasks/$TASK/agent-schedule-access"

# 或普通任务更新（app / UI 走这条）
curl -s -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"agent_schedule_access":"read_only"}' "$BASE/api/tasks/$TASK"
```

非法值 → `400 invalid_agent_schedule_access`。被拒的 agent 调度写/读 → `403 agent_schedule_forbidden`。

要点：

- 只约束 **agent 发起** 的调度调用；**人类 / UI 排期永远不受限**。
- 归属判定靠 `X-Conductor-Actor: agent` 请求头——由 daemon 启动的 `conductor task schedule`（即 `CONDUCTOR_LAUNCHED_BY_DAEMON=1` 下的 SDK）自动带上；人类的普通请求不带。
- 检查的是**实时**任务设置，所以人在 agent 跑的过程中收紧权限，会即时挡住它下一次写。
- ⚠️ **协作式管控，不是硬安全边界**：agent 与用户共享同一 bearer token，若它绕开 CLI 直接发不带该头的裸 HTTP 请求，会被当作人类而不受限。它防的是「按规矩用工具的 agent 乱排期」，不防「故意绕过的 agent」。真正的硬边界需要 per-turn 独立能力令牌。

## 4. 运行时健康预检（自动，信息性）

建 daemon 上的 app task 时，若目标 daemon 明确报告所选 backend 处于**配置了但起不来**的状态（`unauthenticated` / `error`），服务端在写任务/时间线**之前**返回：

```json
{ "error": "runtime_unavailable", "backend": "claude", "daemon_host": "...",
  "reason": "unauthenticated", "message": "...", "recovery": "Sign in to the claude CLI …" }
```

（HTTP `503`）。这样就避免「任务建了但 agent 起不来、用户干等」。

- `missing` 仅作**建议**、不阻断（因为它来自 `which` 探测，看不到自定义/绝对路径的 CLI，硬拦会误伤）。
- 老版 daemon 不播报健康 → 预检 fail open（放行），不影响既有行为。
- 既有的「backend 不在 daemon `supportedBackends` → 409」照常工作。

## 5. Codex 超大线程自愈（自动，无需调用）

`modules/ai-sdk` 的 Codex 会话在一轮失败于**上下文超窗**（远端压缩也救不回来）时，会自动滚到一条全新 provider 线程、带上最近若干条历史作前言、把同一 prompt **重试一次**，并 emit `thread_recovered` 事件——而不是让会话直接死掉。纯自动，无接口可调；观测时留意日志里的 `thread_recovered`。
