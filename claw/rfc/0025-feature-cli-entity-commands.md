# 0025 CLI Entity Commands: project / issue / task

## Status

Proposed

## Owner

TBD

## Date

2026-05-09

## Summary

让 AI（以及人类用户）通过 `conductor` CLI 直接操作 Conductor 的三大核心实体：**project / issue / task**。本 RFC 在现有 CLI dispatcher 上新增三条顶层子命令 `conductor project ...`、`conductor issue ...`、`conductor task ...`，背后统一走 `modules/conductor-sdk` 的 `BackendApiClient`，复用 `~/.conductor/config.yaml` 的 `agentToken` 鉴权。所有命令都支持 `--json` 输出，便于 AI Agent（Claude Code、Cursor、Codex 等）通过 shell 调用进行函数式操作。本期**不**引入 MCP server。

## Context

- 现状：`cli/bin/conductor.js:38` 的 dispatcher 只有 `fire / daemon / config / update / diagnose / send-file / channel / serve-ai`，没有任何对 issue / task / project 实体的 CRUD 命令。
- 服务端 REST 已经具备所需能力：
  - `GET/POST /api/issues`、`GET/PATCH/DELETE /api/issues/[issueId]`（[web/src/app/api/issues/route.ts](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/web/src/app/api/issues/route.ts)）
  - `GET/POST /api/tasks`、`GET/PATCH /api/tasks/[taskId]`、`GET/POST /api/tasks/[taskId]/messages`（[web/src/app/api/tasks/[taskId]/messages/route.ts](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/web/src/app/api/tasks/[taskId]/messages/route.ts)）
  - `GET/POST/PATCH/DELETE /api/projects`（[web/src/app/api/projects/route.ts](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/web/src/app/api/projects/route.ts:266-841)）。POST 支持两类：① `is_default: true` 创建默认项目；② 普通项目，需要 `daemonHost + workspacePath`（daemon 校验通过）或 `bindingCandidate` metadata。
  - 项目隐藏能力（RFC 0024）已上线：PATCH `/api/projects?projectId=...` 接受 `hidden: boolean`；schema 中已有 `Project.hiddenAt` 列；默认项目隐藏会被服务端拒绝（400）。
  - 状态联动：PATCH issue → `doing` 自动起 task；→ `done` 自动 kill task。
- SDK：`modules/conductor-sdk/src/backend/client.ts` 的 `BackendApiClient` 已经处理 base URL、Bearer token、错误包装；并已实现 `listProjects` 和 `matchProjectByPath` 两个项目解析能力。
- 鉴权：`Authorization: Bearer <agentToken>`，token 在 `UserToken` 表，`POST /api/auth/tokens` 已能签发。
- 三个具体动机场景：
  1. 和 AI 聊完后，AI 调命令在当前 project 批量创建 issue（前端可见）。
  2. `doing` 的 issue，QA 通过后命令把状态设为 `done`。
  3. 通过命令行向指定 task 发一条消息（注入到正在进行的 AI 对话）。
- 上一轮设计稿曾考虑 MCP，但本期决定**只做 CLI**：CLI 是最低公分母——shell-out 任何 AI Agent / CI 都能用，不引入新协议依赖、不增加运维面，后续如要加 MCP 可以包一层在 CLI/SDK 之上，零代价。

## Goals

- 在 `conductor` CLI 下提供三组实体子命令：`project / issue / task`，覆盖文末"命令矩阵"中标注为 P1 的子命令。
- 命令支持人类可读输出（默认）与 `--json` 机器可读输出，且 `--json` 是 AI 调用的稳定契约。
- "当前 project"具备一套**确定性的解析顺序**（显式 flag > env > cwd 匹配 > defaultProject），无歧义。
- 所有写操作（create / update / send）在 metadata 上自动打 `actor: "cli"` 标记，便于审计与未来追责。
- 鉴权、配置加载、网络层完全复用现有 `conductor-sdk`，CLI 自身不直接拼 HTTP。
- 单元测试 + 一条端到端（E2E）case 覆盖三大场景。

## Non-Goals

- **不**做 MCP server。本期只做 CLI；MCP 留给后续 RFC，可在 CLI/SDK 之上零成本封装。
- **不**改动现有 REST schema 的语义，只补少量字段（见 Proposed Design §5）。
- **不**做"per-project token / scoped token / 限时 token"等鉴权升级。沿用现有用户级 `agentToken`，安全增强放在独立 RFC。
- **不**做 issue / task 的全量字段 CRUD（如 `aiBackendType`、`launchConfig` 这类高级字段），首期只覆盖最常用语义。
- **不**支持 `conductor issue create --from-jsonl FILE` 这类批量入参；调用方循环单条调用即可，配合 `--client-request-id` 已能保证幂等。
- **不**做 `conductor task messages --follow`（即 `tail -f` 式实时跟看）；本期 `messages` 子命令只拉取一段历史消息后退出。需要实时跟看请使用 web 前端。
- **不**实现交互式 TUI；命令一律一行执行、参数化驱动。

## Options Considered

### Option A：扁平多顶层命令（如 `conductor list-issues`、`conductor send-message`）

- Pros
  - dispatcher 改动最小，每个命令一个文件。
- Cons
  - 命令空间一旦展开会变成几十个顶层名，难学难记。
  - 与"实体"概念脱钩，新实体要造新命名风格。

### Option B：实体导向二级命令（如 `conductor issue list`、`conductor task send`）（采纳）

- Pros
  - 与产品三大实体一一对应，心智负担最低。
  - 二级命令文件按实体聚合，便于维护。
  - 与 `gh issue / gh pr`、`kubectl get pods` 等主流 CLI 风格一致，AI 模型在 prompt 里给出例子时容易迁移。
- Cons
  - dispatcher 需要支持两段命令（极小改动，详见 §1）。

### Option C：先做 MCP server

- Pros
  - 对 Claude Desktop / Code / Cursor 这类 MCP 客户端体验更好（自然语言直接触发）。
- Cons
  - 引入新协议、新部署面（stdio 长连接 / 子进程管理）。
  - CI、Codex、shell pipeline 等非 MCP 场景仍要包一层 CLI——等于先做了上层、还得补下层。
  - 本期决定先把 CLI 这条路打通，MCP 留给后续。

## Proposed Design

### 1. CLI dispatcher 改造

修改 [cli/bin/conductor.js](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/cli/bin/conductor.js:38)：

- `validSubcommands` 数组追加：`"project"`, `"issue"`, `"task"`。
- 加载逻辑保持不变：`conductor project list` 仍然 import `conductor-project.js`，并把 `["list", ...rest]` 作为子命令参数透传。
- 帮助文案 `showHelp()` 加三段 example。
- 二级命令的解析、帮助、参数校验由各自的 `conductor-<entity>.js` 文件内部完成，dispatcher 不感知二级命令名。

新增三个文件：

- [cli/bin/conductor-project.js](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/cli/bin/conductor-project.js)
- [cli/bin/conductor-issue.js](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/cli/bin/conductor-issue.js)
- [cli/bin/conductor-task.js](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/cli/bin/conductor-task.js)

每个文件结构相似：

```js
// conductor-issue.js
const subcommands = {
  list: handleList,
  show: handleShow,
  create: handleCreate,
  update: handleUpdate,
  start: handleStart,
  done: handleDone,
  delete: handleDelete,
};

const [sub, ...rest] = process.argv.slice(2);
if (!sub || sub === "--help") return showIssueHelp();
const handler = subcommands[sub];
if (!handler) return errUnknown(sub);
await handler(rest);
```

参数解析使用现有依赖（CLI 里已经在用的轻量 parser，沿用 `fire`/`daemon` 同款，避免引入 `commander`/`yargs` 等新依赖；如果现有 parser 不够用再单独评估）。

### 2. SDK 高层方法（`modules/conductor-sdk`）

在 `BackendApiClient` 之上新增三个 facade（保持 `BackendApiClient` 作为底层 thin client）：

- [modules/conductor-sdk/src/api/projects.ts](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/modules/conductor-sdk/src/api/projects.ts) — `listProjects / getProject / createProject / setDefaultProject / setProjectHidden / resolveProject`
- [modules/conductor-sdk/src/api/issues.ts](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/modules/conductor-sdk/src/api/issues.ts) — `listIssues / getIssue / createIssue / updateIssue / deleteIssue`（`updateStatus` 是 `updateIssue` 的便捷封装）
- [modules/conductor-sdk/src/api/tasks.ts](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/modules/conductor-sdk/src/api/tasks.ts) — `listTasks / getTask / sendTaskMessage / listTaskMessages`

`resolveProject(input)` 是核心工具，按下列优先级返回 `{ id, name, daemonHost }`：

1. `input.id` 显式给出 → 直接 `getProject(id)`，找不到报错。
2. `input.name` 显式给出 → `listProjects()` 后按 name 唯一匹配；多匹配/零匹配各自报错。
3. 环境变量 `CONDUCTOR_PROJECT_ID` → 同 (1)。
4. 当前工作目录 → 复用现有 `matchProjectByPath(cwd)`，多匹配/零匹配报错。
5. 用户的 `defaultProject` → 用 `GET /api/projects/default` 兜底。
6. 全部失败 → 抛 `ProjectNotResolvedError`，CLI 打印明确指引（"请使用 --project <id|name> 或 cd 进入项目目录"）。

测试：[modules/conductor-sdk/tests/api/issues.test.ts](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/modules/conductor-sdk/tests/api/issues.test.ts) 等三个文件，使用现有 mock-server 工具覆盖正反路径。

### 3. 命令矩阵

> P1 = 本 RFC 必须实现；P2 = 本 RFC 验收后立即跟进；P3 = 暂不实现，列出仅为完整性。

**全局 flag**（所有写操作子命令统一支持，P1）：

- `--dry-run`：不发起任何会改服务端状态的请求，改为打印**将要发送的请求摘要**（method、URL、body），并以退出码 0 退出。`--json` + `--dry-run` 同时使用时，输出形如 `{"dryRun": true, "request": {"method": "POST", "url": "...", "body": {...}}}`。仅作用于写动作（create / update / start / done / send / hide / unhide / set-default / delete），读动作（list / show / current / messages）忽略该 flag。
- `--json`：稳定的机器可读输出（详见 §4）。
- `--project <id|name>`：项目解析显式覆盖（详见 §2）。
- `--config-file <path>`：自定义配置文件路径，与 `daemon` 子命令一致。

#### `conductor project`

| 子命令 | 优先级 | 说明 |
|---|---|---|
| `list [--include-hidden]` | P1 | 列出当前用户的项目；默认隐藏 `hiddenAt != null` 的项目，`--include-hidden` 全量；`--json` 输出 `{id, name, daemonHost, workspacePath, isDefault, hidden}`。 |
| `show [<id\|name>]` | P1 | 展示项目详情；不传参数时按 §2 优先级解析"当前项目"。 |
| `current` | P1 | 等价于 `show`，但**强制**只输出 id（适合 shell substitution，如 `conductor issue list --project "$(conductor project current)"`）。 |
| `create [--name <n>] [--workspace-path <p>] [--daemon-host <h>] [--default] [--client-request-id <key>]` | P1 | 创建项目，调 `POST /api/projects`。`--default` 创建默认项目（与所有 binding 字段互斥）；非默认时 `--workspace-path` 缺省取 cwd、`--daemon-host` 缺省取本地 daemon 配置。Daemon 必须可达以便服务端校验绑定（与现有 web 创建流程一致）。 |
| `set-default <id\|name>` | P1 | 切换用户的默认项目。 |
| `hide <id\|name>` | P1 | 调 PATCH `{hidden: true}`；默认项目会被服务端拒绝并返回退出码 2 + 明确错误。 |
| `unhide <id\|name>` | P1 | 调 PATCH `{hidden: false}`。 |
| `delete <id\|name>` | P2 | 调 DELETE，需 `--yes` 二次确认。 |

#### `conductor issue`

| 子命令 | 优先级 | 说明 |
|---|---|---|
| `list [--project ...] [--status <s>] [--limit N]` | P1 | 列出 issue；`--status` 支持逗号分隔。 |
| `show <id>` | P1 | 展示 issue 详情，含关联 task 列表。 |
| `create --title <t> [--description <d>] [--priority P1\|P2\|P3] [--status backlog\|doing\|done] [--description-file FILE] [--description-stdin] [--client-request-id <key>] [--project ...]` | P1 | 创建 issue，覆盖场景 ①。`description-file/stdin` 支持长描述。`--client-request-id` 用于幂等（详见 §5）。 |
| `update <id> [--title ...] [--description ...] [--priority ...] [--status ...]` | P1 | 任意子集字段 PATCH。 |
| `start <id>` | P1 | `update --status doing` 的别名，覆盖"backlog → doing → 自动起 task"流程。 |
| `done <id> [--evidence <text\|@file>]` | P1 | `update --status done` 的别名；`--evidence` 写入 `metadata.qa.evidence`，覆盖场景 ②。 |
| `delete <id>` | P2 | 调 `DELETE /api/issues/[id]`，需要 `--yes` 二次确认。 |

#### `conductor task`

| 子命令 | 优先级 | 说明 |
|---|---|---|
| `list [--project ...] [--issue <id>] [--status ...]` | P1 | 列出 task。 |
| `show <id>` | P1 | 展示 task 详情。 |
| `send <id> [<message>] [--stdin] [--from-file FILE] [--metadata-json '{...}']` | P1 | 向运行中 task 发消息，覆盖场景 ③。`message` 与 `--stdin/--from-file` 三选一。 |
| `messages <id> [--limit N] [--before <msg-id>]` | P1 | 拉取一段历史消息后退出；不实现 `tail -f` 式 follow（如需实时跟看，本期请使用 web 前端）。 |
| `cancel <id>` | P2 | 调 PATCH 把状态置为 `cancelled`/`stopped`。 |
| `restart <id>` | P2 | 与 RFC 0021 协同，留接口位。 |

### 4. 输出格式

- **默认（人类）**：紧凑表格 / KV 形式。例：`conductor issue list` 输出 `ID  STATUS  PRIORITY  TITLE`。
- **`--json`**：稳定契约，永远输出单一 JSON（数组或对象）。AI Agent 应只依赖 `--json`。
- **退出码**：`0` 成功；`1` 通用失败；`2` 参数错误；`3` 鉴权失败；`4` 实体未找到；`5` 项目无法解析。

### 5. 服务端最小变更

为了 CLI / AI 调用更稳定，服务端补两点（都是新增字段，向后兼容）：

1. **幂等键**：`POST /api/issues` 和 `POST /api/tasks/[id]/messages` 入参可选 `clientRequestId`，落到对应表的 `metadata.clientRequestId` 上；若同一 `(userId, projectId, clientRequestId)` 已存在记录则返回旧记录（200 而非 409，以便重试无副作用）。
   - 影响文件：[web/src/app/api/issues/route.ts](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/web/src/app/api/issues/route.ts)、[web/src/app/api/tasks/[taskId]/messages/route.ts](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/web/src/app/api/tasks/[taskId]/messages/route.ts)。
   - DB：不加列，存在 `metadata` JSON；若发现性能/查询瓶颈再单独迁移到列+唯一索引。
2. **审计字段**：所有 CLI 写操作在请求 metadata 上自动打：
   ```json
   { "actor": "cli", "cliVersion": "<pkg.version>", "invokedBy": process.env.CONDUCTOR_INVOKED_BY ?? null }
   ```
   服务端不强制校验，只做透传 + 落库。AI Agent 调用时设置 `CONDUCTOR_INVOKED_BY=claude-code` 等即可被记录。

3. **Issue 实时广播**：`POST /api/issues` 成功后，通过现有 WebSocket 通道向**所属 user 的所有连接**推一条 `issue.created` 事件，payload 至少含 `{ projectId, issue: <serialized> }`。前端在 issue 列表 store 里订阅该事件并直接合并到本地状态，避免依赖轮询/SWR 间隔。
   - 影响文件：`POST /api/issues` 处理函数（在写入 DB 后立即广播）；前端 issue 列表 store / hook。
   - 与 `clientRequestId` 幂等的交互：当幂等命中返回旧记录时**不**广播，避免重复事件。
   - 不在本 RFC 扩展到 `issue.updated / issue.deleted`，但留下推送通道格式以便后续扩展。

> 这三点都是"加字段/加事件，不破坏旧 client"。三者可拆为三个独立 PR 串行合入。

### 6. 鉴权与配置加载

- 完全复用 `~/.conductor/config.yaml` + `agentToken`。
- CLI 启动时若 token 缺失，提示 `conductor config` 走交互式配置（已有命令）。
- `--config-file <path>` 支持指向自定义配置（与 `daemon` 子命令一致）。
- 不引入新的 token / scope；本期接受"CLI 持有用户级 token，等同于用户全权"的现状。

### 7. 三个目标场景的端到端示意

#### 场景 ①：AI 聊天梳理后批量建 issue

```bash
# 假设 cwd 已经在某项目下，CLI 自动解析项目
for i in 1 2 3; do
  conductor issue create \
    --title "Refactor module $i" \
    --description-file "/tmp/issue-$i.md" \
    --priority P2 \
    --client-request-id "chat-2026-05-09-$i" \
    --json
done
# 前端通过现有 SWR 轮询 / WebSocket 看到新 issue（如需即时，参考 §Open Questions 的广播）
```

#### 场景 ②：QA 通过后 doing → done

```bash
conductor issue done ISSUE_ID --evidence @./qa-report.md
# metadata.qa.evidence 写入报告内容；服务端联动逻辑自动 kill 关联 task
```

#### 场景 ③：给指定 task 发消息

```bash
conductor task send TASK_ID "请在你刚才的实现里加上单元测试"
echo "复杂多行内容..." | conductor task send TASK_ID --stdin
```

#### 场景 ④：在 cwd 注册一个新项目并立即开始用

```bash
cd ~/code/my-new-repo
conductor daemon &                 # 确保 daemon 可达（如已运行可跳过）
conductor project create --json    # workspace-path 自动取 cwd，name 自动取目录名
# → {"id": "...", "name": "my-new-repo", "daemonHost": "...", "isDefault": false, "hidden": false}
conductor project set-default "$(conductor project current)"  # 可选：设为默认项目
```

#### 场景 ⑤：隐藏 / 恢复项目

```bash
conductor project hide "Old POC"
conductor project list                   # 列表里不再出现
conductor project list --include-hidden  # 仍然能看到，hidden=true
conductor project unhide "Old POC"
```

### 8. 测试策略

- **SDK 单测**：`modules/conductor-sdk/tests/api/{projects,issues,tasks}.test.ts`，mock HTTP 层覆盖正反路径，包括 `resolveProject` 五条优先级。
- **CLI 单测**：`cli/test/conductor-{project,issue,task}.test.js`，注入 SDK mock，覆盖参数解析、--json 输出、退出码。
- **服务端**：在 [web/src/app/api/issues/route.test.ts](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/web/src/app/api/issues/route.test.ts) 等加 `clientRequestId` 幂等用例。
- **E2E（手动）**：按 `CLAUDE.md` 的 "E2E Test in Local Development" 流程，跑通三个场景各一次，截图存到 PR。

## Risks

- **AI 误操作**：用户级 token 落 CLI 后，AI Agent 拿到 shell 即等于全权。缓解：①审计 metadata；② 写操作打 `--dry-run`（P2，输出将要发的请求体不真发）；③ 后续 RFC 引入 scoped token。
- **幂等键冲突**：客户端拼 `clientRequestId` 时如果碰撞会被服务端复用旧记录，看起来像"创建成功"但内容不一致。缓解：CLI 不自动生成 `clientRequestId`，仅当用户/AI 显式传入时才幂等；不传则每次新建。
- **项目解析歧义**：cwd 匹配若多项目命中（worktree 套娃），命令直接报错并要求显式 `--project`。
- **二级命令帮助信息不够直观**：通过 `conductor issue --help`、`conductor issue create --help` 双层 help 缓解；且 `--json` 输出本身可以作为契约文档。
- **CLI 启动时间**：每条命令都要 `import` SDK，可能比 `gh` 等慢。缓解：保持 SDK lazy import（按子命令动态 import），避免一次性加载所有 facade。

## Rollout

1. **SDK**：先合入 `modules/conductor-sdk` 的三个 facade + `resolveProject` + 单测。独立 PR，风险隔离。
2. **服务端**：合入 `clientRequestId` 幂等 + metadata 审计透传 + `issue.created` WebSocket 广播。其中"幂等 / 审计 / 广播"建议拆为三个独立 PR 串行合入；广播 PR 同时改前端 issue store 订阅逻辑。
3. **CLI**：合入 dispatcher 改造 + 三个 `conductor-*.js` 文件 + 单测；按命令矩阵 P1 全量交付。
4. **文档**：更新 [CLAUDE.md](/Users/duino/ws/conductor/.conductor/worktrees/779e75b5-e340-4363-8d97-546c716a50f1/CLAUDE.md) 的命令清单 + `cli/README` 加用法示例。
5. **E2E**：按 `CLAUDE.md` 的本地 E2E 流程跑一遍三大场景，截图入 PR。
6. **发布**：随下一次 CLI 发布走 `claw/sop/06_release.md` 标准流程；首发只在 `conductor-dev` 验证一周后再 cut release。

向后兼容：纯增量、不改任何现有命令行为；无环境变量重命名；无配置 schema 变更。

## Acceptance

- `conductor project list/show/current/create/set-default/hide/unhide` 七个命令都能正常工作，并支持 `--json`。
- `conductor project hide` 在默认项目上返回明确错误并以非零退出码退出（沿用服务端 400 "Default project cannot be hidden"）。
- `conductor project create` 在 cwd 内无 daemon 可达时给出可操作的报错（提示先 `conductor daemon` 或显式传 `--daemon-host`）。
- `conductor issue list/show/create/update/start/done` 全部 P1 子命令通过单测和 E2E。
- `conductor task list/show/send/messages` 全部 P1 子命令通过单测和 E2E。
- 三大目标场景在本地按上文示意脚本可一次性跑通，前端能看到对应变化。
- 通过 CLI（或任何客户端）调用 `POST /api/issues` 成功后，**已打开 web 前端的同账号会话**在不刷新页面的前提下能在 1 秒内看到新 issue 出现在列表中（依赖 §5.3 的 `issue.created` 广播）；当 `clientRequestId` 命中已存在记录返回旧记录时**不**触发广播。
- 无 token / 项目解析失败时，CLI 给出**可操作**的错误信息（指明下一步命令），退出码符合 §4 约定。
- 所有写操作子命令支持 `--dry-run`：服务端不被调用（可通过 mock HTTP 的"零次调用"断言），CLI 打印将要发送的请求摘要并以退出码 0 退出；`--json --dry-run` 输出符合 §3 全局 flag 约定的结构。
- `conductor --help` 列出 `project / issue / task` 三条新命令。
- SDK / CLI / 服务端三处单测通过：`cd web && pnpm test`、`cd modules/conductor-sdk && pnpm test`、`cd cli && pnpm test`（如 cli 已有 test 配置）。

## Open Questions

- **未来 MCP**：本期纯 CLI；未来若加 MCP，可在 `modules/conductor-sdk` facade 上薄薄套一层，不影响本 RFC 的设计。
