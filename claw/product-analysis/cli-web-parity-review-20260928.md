# Conductor CLI 与 Web 前端功能对齐 Review（2026-09-28）

基线：`main` @ `f795a61`（version packages）。

## 方法

1. 列出 `web/src/app/api/**/route.ts` 下全部 114 个路由及其 HTTP 方法。
2. 从 `web/src/features/**`、`web/src/app/app/**` 中提取前端实际调用的接口（`getApiClient().get/post/patch/put/delete`），得到“前端能做的事”。
3. 对照 `cli/bin/conductor-*.js` 中的 yargs 子命令，以及 CLI 所依赖的 `modules/conductor-sdk/src/api/*`。
4. 以下接口不属于“用户操作”，不计入对齐范围：daemon/agent 内部接口（`/api/agent/*`、`runtime-status`、`digest`、`agent-schedule-access`、`attachments/.../materialized`）、登录与 OAuth 流程、支付与订阅、cron、webhook、语音转写、邀请统计、`/api/shared/[token]` 公开只读页。

## 结论

**两者目前没有对齐。** CLI 覆盖了“创建和驱动任务”这条主线：task 的 create/send/insert/messages/schedule、project 的 list/create/default/hide、issue 的 CRUD（缺 delete）、daemon 的 list/tools/quota、remote exec/cp、diagnose、send-file。
但近几个版本在前端新增的大部分功能，CLI 都**没有对应命令**，主要包括：任务生命周期（停止、中断、重启、删除、归档）、多 agent 组、worktree/远程 worktree、全局 AI 后端、持久任务与轮次、恢复会话、标签、分享、daemon 重启/更新、AI 账号切换、自定义命令、daemon 共享、协作、全局搜索、用户偏好（口头禅、日报、全局后端）。

粗略统计：前端调用的用户级接口约 **60 个**，CLI 覆盖约 **17 个（≈28%）**。

另外，SDK 层（`modules/conductor-sdk/src/api/tasks.ts`、`projects.ts`、`issues.ts`）本身也只封装了 CLI 当前用到的这些方法。所以补齐 CLI 时，SDK 也要一起补（`deleteIssue` 除外，它已经存在，只是 CLI 还没接上）。

---

## 对照表

图例：✅ 已对齐　⚠️ 部分对齐（缺参数）　❌ CLI 缺失
优先级：**P1** = 核心工作流，脚本或 agent 会用到；**P2** = 常用管理操作；**P3** = 偏好设置或 UI 专属功能

### 1. 任务（Task）

| 前端能力 | API | CLI 现状 | 优先级 |
|---|---|---|---|
| 任务列表（按项目、多项目合并、状态） | `GET /api/tasks` | ⚠️ `task list` 只能看单个项目，不支持 `project_ids` 合并视图 | P2 |
| 已归档任务列表 / 搜索 | `GET /api/tasks/achieved` | ✅ `task list --archived --search --all-projects` | – |
| 查看详情 | `GET /api/tasks/:id` | ✅ `task show` | – |
| 查看多 agent 组 | `GET /api/tasks/:id/group` | ✅ `task group` | – |
| **创建任务：选 daemon（agentHost）** | `POST /api/tasks` `agentHost` | ❌ 不能指定 | P1 |
| **创建任务：多 agent 组（worker + reviewers，RFC 0033）** | `agents: [{name, backend}]` | ❌ | P1 |
| **创建任务：全局 AI 后端（RFC 0041）** | `globalBackend: {host, backend}` | ❌ | P1 |
| **创建任务：本地 worktree / 远程 worktree** | `launchConfig.worktree` / `launchConfig.remoteWorktree.host` | ❌ | P1 |
| **创建任务：持久任务（RFC 0039）** | `metadata.persistent.enabled` | ❌ | P1 |
| 创建任务：恢复已有 CLI 会话（Resume Session） | `sessionId`/`sessionFilePath` + `GET /api/agents/:host/sessions` | ❌（CLI 只有本地的 `fire --resume`，不能通过服务端创建） | P2 |
| 创建终端任务（Terminal 模式） | `taskType` + `POST /api/tasks/:id/terminal` | ❌ | P3 |
| 发送消息 | `POST /api/tasks/:id/messages` | ✅ `task send` | – |
| 发送消息时附带附件 | `POST /api/tasks/:id/attachments` + `attachmentIds` | ⚠️ `send-file` 能上传文件，但 `task send` 不能带 `--attach` | P2 |
| 插入消息（打断当前轮后先执行） | `POST /api/tasks/:id/insert` | ✅ `task insert` | – |
| **中断当前轮（Stop 按钮）** | `POST /api/tasks/:id/interrupt` | ❌ | P1 |
| **停止 / kill 任务** | `PATCH /api/tasks/:id {status:'killed'}` | ❌ | P1 |
| **重启任务（原地 / 新任务、切换后端、刷新会话、换 daemon、首条消息）** | `POST /api/tasks/:id/restart` | ❌ | P1 |
| **删除任务（含 `?permanent=1`）** | `DELETE /api/tasks/:id` | ❌ | P1 |
| **归档 / 取消归档** | `POST /api/tasks/:id/achieve`、`/unachieve` | ❌ | P1 |
| 重命名 | `PATCH /api/tasks/:id {title}` | ❌ | P2 |
| 置顶 / 取消置顶 | `PATCH … {metadata.pinnedAt}` | ❌ | P3 |
| 移动到另一个项目（仅显示层面） | `PUT /api/tasks/:id/second-project` | ❌ | P2 |
| 设置任务标签 | `PUT /api/tasks/:id/labels` | ❌ | P2 |
| 分享 / 取消分享链接 | `POST/DELETE /api/tasks/:id/share` | ❌ | P2 |
| 持久任务设置 | `PATCH /api/tasks/:id/persistent` | ❌ | P2 |
| 结束当前轮 / 开始新一轮（backend、agent_host、worktree 选 inherit/new/none） | `POST /api/tasks/:id/rounds/end`、`/rounds` | ❌ | P2 |
| 清理任务 worktree | `POST /api/tasks/:id/worktree` | ❌ | P2 |
| 读取消息 | `GET /api/tasks/:id/messages` | ⚠️ `task messages` 有，但没有 `--follow`，只能轮询 | P2 |
| 定时消息：列表、创建、删除 | `GET/POST/DELETE …/scheduled-messages` | ✅ `task schedule list/create/delete` | – |
| 定时消息：编辑 | `PATCH …/scheduled-messages/:sid` | ❌ | P2 |
| PTY 终端接入、开关 | `…/terminal` + WebSocket | ❌（交互式终端，可以不做，或做成 `task attach`） | P3 |
| 任务诊断 | `GET /api/diagnostics/tasks/:id` | ✅ `conductor diagnose` | – |

### 2. 项目（Project）

| 前端能力 | API | CLI 现状 | 优先级 |
|---|---|---|---|
| 列表、详情、当前项目 | `GET /api/projects` | ✅ `project list/show/current` | – |
| 创建（含 create-workspace、default） | `POST /api/projects` | ✅ `project create` | – |
| 设为默认 | `PATCH` | ✅ `project set-default` | – |
| 隐藏 / 取消隐藏 | `PATCH {hidden}` | ✅ `project hide/unhide` | – |
| 修改项目（重命名、工作区路径等） | `PATCH /api/projects?projectId=` | ❌ | P2 |
| **删除项目** | `DELETE /api/projects?projectId=` | ❌ | P1 |
| 跨 daemon 合并开关（mergeOptOut） | `PATCH {mergeOptOut}` | ❌ | P3 |
| 刷新项目状态 | `PATCH {refresh:true}` | ❌ | P3 |
| 调整项目顺序 | `POST /api/projects/reorder` | ❌ | P3 |
| 查看项目可用的 agent 列表 | `GET /api/projects/:id/agents` | ❌（建任务选 `agents` 时需要） | P2 |
| 协作：生成邀请、加入、退出 | `POST /projects/:id/collaboration`、`POST /collaboration/join`、`DELETE /collaboration/:id/members/me` | ❌ | P2 |
| 项目卡片分组 / 任务卡片分组 | `GET/PATCH /user-preferences/{project,task}-card-groups` | ❌ | P3 |

### 3. Issue

| 前端能力 | API | CLI 现状 | 优先级 |
|---|---|---|---|
| 列表、详情、创建、修改、start、done | `/api/issues` | ✅ | – |
| **删除** | `DELETE /api/issues/:id` | ❌（SDK 已有 `deleteIssue`，CLI 没接） | P1（改动小） |
| 跨项目合并列表 | `GET /api/issues?project_ids=` | ❌ | P3 |

### 4. Daemon / Agent / AI 管理

| 前端能力 | API | CLI 现状 | 优先级 |
|---|---|---|---|
| 在线 daemon 列表、工具、额度 | `GET /api/agents`、`/ai-manager/status`、`/ai-manager/quota` | ✅ `daemon list/tools/quota` | – |
| **远程重启 daemon** | `POST /api/agents/:host/restart` | ❌（`daemon --force` 只能重启本机） | P1 |
| **远程更新 daemon、查看更新状态** | `POST/GET /api/agents/:host/update` | ❌（`conductor update` 只能更新本机） | P1 |
| AI 账号列表 / 切换账号 | `GET /ai-manager/accounts`、`POST /ai-manager/switch` | ❌ | P2 |
| 自定义命令：列表、执行、查看结果 | `/agents/:host/custom-commands`、`/run`、`/runs/:id` | ❌ | P2 |
| 可恢复会话列表 | `GET /api/agents/:host/sessions` | ❌ | P2 |
| 远程执行、传文件 | `/agents/:host/exec`、`/files` | ✅ `remote exec/cp/wait/mcp`（CLI 这边比前端还全） | – |
| Daemon 共享：创建、列出、撤销、接受邀请 | `/api/daemon-shares*` | ❌ | P2 |

### 5. 用户与全局

| 前端能力 | API | CLI 现状 | 优先级 |
|---|---|---|---|
| 全局搜索（任务、消息、项目） | `GET /api/search?q=` | ❌（只能在归档任务里搜） | P2 |
| 全局 AI 后端配置 | `GET/PUT /user-preferences/global-ai-backends` | ❌ | P2 |
| 口头禅（catchphrases）增删改、排序 | `/user-preferences/catchphrases*` | ❌ | P3 |
| 日报：查看、生成、设置 | `/api/daily-reports`、`/user-preferences/daily-report` | ❌ | P3 |
| 任务列表偏好 | `/user-preferences/task-list` | ❌（UI 专属，可以不做） | P3 |
| 当前用户 | `GET /api/auth/me` | ⚠️ 没有 `whoami` | P3 |
| API Token：创建、列出、撤销 | `/api/auth/tokens*` | ⚠️ `conductor config` 可以走设备码登录拿 token，但没有 list/revoke | P3 |
| 渠道绑定（飞书） | `/api/channel/*` | ✅ `channel connect feishu` | – |

---

## 建议的补齐顺序

**第一批（P1，保证 agent 和脚本能跑完整个任务生命周期）**
1. `task stop <id>`（PATCH status=killed）、`task interrupt <id>`
2. `task restart <id> [--strategy inplace|new_task] [--backend] [--refresh-session] [--daemon-host] [--first-message]`
3. `task delete <id> [--permanent]`、`task archive <id>`、`task unarchive <id>`
4. `task create` 增加参数：`--daemon-host`、`--agent <name>[:backend]`（可重复，第一个是 worker）、`--global-backend host:backend`、`--worktree`、`--remote-worktree <host>`、`--persistent`
5. `issue delete <id>`、`project delete <id>`
6. `daemon restart <host>`、`daemon upgrade <host> [--status]`（避免和本机的 `conductor update` 混淆）

**第二批（P2）**
- `task rename/move/labels/share/unshare/cleanup-worktree`、`task round end|start`、`task persistent set`
- `task send --attach FILE`、`task messages --follow`、`task schedule update`
- `task resume --daemon-host <h> --session <id>`，以及 `daemon sessions <host>`
- `project update/agents`、`project collab invite|join|leave`
- `daemon accounts <host>`、`daemon switch-account`、`daemon commands list|run|status`
- `daemon share create|list|revoke|accept`
- `conductor search <q>`、`conductor settings global-backends get|set`

**第三批（P3，可选）**：置顶、排序、卡片分组、口头禅、日报、token 管理、`whoami`、PTY attach。

## 让两边以后保持对齐

现在两边分开开发，前端加功能时没有任何机制提醒 CLI 跟进。建议：
1. 新增 `cli/test/api-parity.test.js`：列出所有 `web/src/app/api/**/route.ts` 的方法，和一份清单（`cli/api-parity.json`）对照。清单里每个“路由 + 方法”要么写对应的 CLI 命令，要么写 `"web-only": "<理由>"`。新增路由但清单没更新时，测试直接失败。
2. 在 `claw/sop/04_review-code.md` 的 review 检查项里加一条：“新增或修改用户级 API 时，是否同步了 SDK 和 CLI？”
3. CLAUDE.md 里现在的要求是“每个功能至少有一个 API 路由测试，外加一个 widget 或 SDK 测试”。可以改成“用户级功能必须有 SDK 方法 + CLI 命令 + CLI 测试”。

---

## 补齐状态（2026-09-29）

上面的 P1、P2、P3 已全部实现。新命令通过 `cli/src/backend-http.js` 直接调用前端使用的同一批 `/api/...` 路由，所用 token 与 SDK 相同，因此不依赖 SDK 发版。

| 领域 | 新增命令 | 代码位置 |
|---|---|---|
| task | `stop` `interrupt` `restart` `delete --yes [--permanent]` `archive` `unarchive` `rename` `pin/unpin` `move [--back]` `labels [--clear]` `share/unshare` `persistent` `round start/end` `cleanup-worktree` `terminal open/show/close` `resume` `schedule update`；`create` 新增 `--daemon-host --agent --global-backend --worktree --remote-worktree --persistent`；`send --attach`；`messages --follow`；`list --all-projects / --project-ids` | `cli/src/task-commands.js`、`cli/bin/conductor-task.js` |
| project | `update` `refresh` `delete --yes` `reorder` `agents` `collab invite/join/leave` `labels list/add/rename/remove` | `cli/bin/conductor-project.js` |
| issue | `delete --yes`、`list --all-projects / --project-ids` | `cli/bin/conductor-issue.js` |
| daemon | `restart` `upgrade [--status/--wait]` `sessions` `accounts` `switch-account` `commands list/run/status` `share create/list/revoke/show-invite/accept` | `cli/src/daemon-share-commands.js` |
| 用户与全局 | `conductor search`；`conductor settings global-backends/catchphrases/daily-report/task-list/task-card-groups/project-card-groups/reports`；`conductor auth whoami/tokens list/create/revoke` | `cli/bin/conductor-{search,settings,auth}.js` |

**有意不做的：**
- 登录、注册、OAuth、支付：登录已经由 `conductor config` 负责。
- `GET /api/daemon-shares/mine`：这是 owner 的 daemon 用来拉取 guest token 的接口，会明文返回凭据。别人共享给你的 daemon 已经显示在 `conductor daemon list` 里。
- `GET /api/auth/tokens/latest`：会打印原始 token。
- PTY 交互式接入：CLI 只能开关终端、查看终端对应的任务。交互式终端可以直接用 `conductor remote exec`。

**顺带修复：** `project hide/unhide` 会清空项目的 metadata，详见 `claw/lessons/arch_cli-project-hide-wipes-project-metadata-20260929.md`。

**尚未做：** 第一部分建议的 API 对齐检查测试（`cli/api-parity.json` 清单 + 测试）。
