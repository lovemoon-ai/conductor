# 0041 全局 AI 后端（Global AI Backend）

## Status

Implemented（2026-09-26 web：设置、创建、重启继承、任务卡提示；单元 / API / 组件测试）

## Owner

dang217

## Date

2026-09-26

## Summary

用户在**设置**里把若干 "daemon × AI 工具"（如 `macmini / claude`）标记为**全局后端**。之后在任意项目里创建任务，除了项目所在 daemon 自己的 AI 工具，还可以选这些全局后端：AI 跑在全局后端所在的 daemon A，代码、构建、测试落在项目所在的 daemon B。A 与 B 相同就是普通本地任务，不走 remote。

实现上是 RFC 0038 remote worktree 的"反向入口 + 放宽"：0038 从 A 的项目出发，要求 B 上有同一合并组的项目；本 RFC 从 B 的项目出发，A 上不需要有这个项目。

**"用哪个 AI 后端"与"用不用 worktree"是两个正交的选项**：选了全局后端，worktree 仍由用户勾选决定——勾选则在 B 上建 worktree（0038 机制），不勾则 AI 直接在 B 的项目目录里工作，与本地任务的语义一致。

不改 schema、不加协议事件，daemon / fire / ai-sdk 零改动。

这是可选增强，默认关闭：用户没有配置全局后端时，创建任务的界面和行为与今天完全一致。

## Context

- 今天任务的 AI 后端钉死在项目所在的 daemon：`POST /api/tasks` 强制 `agentHost = project.daemonHost`（`web/src/app/api/tasks/route.ts:773-786`），创建对话框的后端列表就是这台 daemon 的 `supportedBackends`（`CreateTaskDialog.tsx:373-395`）。
- 后果：项目在一台没有 AI 条件（不能出网、没有账号）的机器上时，这个项目开不了 AI 任务。
- RFC 0038 已实现"AI 在 A、代码在 B"，但要求 A 也绑定了同名、同 `gitRemoteUrl` 的项目（合并组），入口也只对合并组开放。这正是本 RFC 要去掉的耦合。
- 底层通道已具备：任务 shell 带 `CONDUCTOR_AGENT_TOKEN`，AI 可用 `conductor remote exec / cp / wait` 操作同账号下任意在线 daemon（RFC 0034 / 0037）。

## Goals

- 用户在设置中选择哪些 "daemon × 后端" 成为全局后端。
- 任意项目（绑定在自己任意 daemon 上）创建任务时可选这些全局后端。
- 任务显示在发起它的项目（B 的项目）下；"AI 跑在哪台机器"这一信息低调展示、但能找到。
- 停止、重启、日志、删除/归档清理与普通任务一致。
- worktree 与全局后端正交：两种组合（勾 / 不勾）都支持，语义与本地任务一致。
- Claude Code 与 Codex 同一套机制。

## Non-Goals

- 不跨账号：全局后端和目标项目都必须属于当前用户；DaemonShare 分享来的 daemon 既不能设为全局后端，也不能作为目标。
- MCP 远程文件工具由 RFC 0040（`conductor remote mcp`）提供：`remoteWorktree` 与本 RFC 的 `remoteWorkspace` 都会让 fire 挂上绑定到 B 的 `remote_*` 工具（direct 模式绑定到仓库根，起始目录为项目目录）。
- 不做经后端中转的模型出网（0038 方案 A）。
- 一期不支持多 agent 组、PTY 任务、附属终端开到 B。

## Proposed Design

### 1. 设置：全局后端列表

- 存储：`UserPreference`，key `global_ai_backends`，value 为 JSON：

  ```json
  { "backends": [{ "host": "macmini", "backend": "claude" }, { "host": "macmini", "backend": "codex" }] }
  ```

  沿用 `lib/user-preferences.ts` 的 get/set 模式与 `user-preferences/*` 路由模式（参考 `task-list/route.ts`），不改 schema。
- API：`GET / PUT /api/user-preferences/global-ai-backends`。PUT 校验：
  - 每项 `host` 是当前用户自己的 daemon、不是 fire host（`conductor-fire-*`）。新加的条目要求 daemon 在线且当前声明了该后端；已保存的条目在 daemon 离线时保留（可删不可加）。
  - `backend` 为已知后端类型（`normalizeBackendType`）。
  - `daemon_share` scope 的 token 403。
  - 去重，数量上限 32。
- 设置页（`web/src/app/app/settings/page.tsx`）新增一节 "Global AI backends"：按 daemon 分组列出其 `supportedBackends` 的勾选框；离线 daemon 仍显示已勾选项（置灰、不可新勾）。

### 2. 创建任务对话框

- 后端下拉 = 项目所在 daemon 的后端（今天的行为）+ 分隔线 + "Global" 分组。未配置全局后端时没有这个分组，界面与今天完全相同。
- Global 分组列出设置中所有 **daemon ≠ 项目 daemon** 的项，显示为 `claude @ macmini`：
  - 在线且该 daemon 当前声明了此后端：可选。
  - 离线，或在线但不再支持该后端：**置灰、不可选**，悬停提示原因（"macmini is offline" / "codex is not available on macmini"）。
- **worktree 勾选项始终保留**，默认值与本地任务相同（沿用用户上次的选择），语义随后端切换：

  | 所选后端 | 勾选 worktree | 不勾 |
  |---|---|---|
  | 本项目 daemon（本地） | daemon 预先在本机建 worktree（现状） | 直接在项目目录工作（现状） |
  | 全局后端（A ≠ B） | AI 在 B 上建 worktree（0038 `remoteWorktree`） | AI 直接在 B 的 `workspacePath` 工作（新 `remoteWorkspace`） |

- 选中全局后端时只禁用两项：0038 的 "Workspace on another daemon"（已无意义）与 agent group（一期不支持）。
- 请求体：`project_id = B 的项目`，`global_backend: { host: "macmini", backend: "claude" }`，`backend_type` 同步为该后端，`launch_config.worktree` 照常按勾选传 `true` / 不传。

### 3. 服务端（`POST /api/tasks`）

在读取 `project` 之后、现有校验之前，若请求带 `global_backend`，执行 "重挂载"，其后的流程全部复用现有代码。

校验（按顺序，任一不满足即返回）：

| 条件 | 状态码 |
|---|---|
| token 为 `daemon_share` | 403 |
| `task_type` 不是 `ai_task`；与 `remoteWorktree`（0038 入口）/ agent group 同时出现 | 400 / 409 |
| `global_backend` 不在用户的 `global_ai_backends` 设置中 | 409 |
| B 的项目没有 `daemonHost` / `workspacePath` / `repoRoot`（未绑定或不是 git 仓库） | 409 |
| A == B 的 daemon | 忽略 `global_backend`，按普通本地任务处理（`worktree` 照常生效） |
| A 离线 / 不支持该后端 / runtime-health 预检不过 | 409（沿用现有检查） |
| A 的 CLI 没有声明 `global_backend_v1`（旧版本，驱动不了 `conductor remote`、不会给 remoteWorkspace 挂 MCP 工具） | 409，对话框里该项置灰并提示升级 |
| B 离线 / 未声明 `remote_exec` + `remote_file` | 409 |

重挂载（保持 `agentHost = project.daemonHost` 不变量，0038 §2 的理由不变）：

1. 在 A 上所有同名项目里找与 B 项目可合并的那个（`canMergeProjectsByFields`，与 0038 相同判定；同名但不是同一仓库的跳过）：
   - 找到 → 任务的真实 `projectId` 挂它，AI cwd = 它的 `workspacePath`（有本地 clone，CLAUDE.md 等自动加载）。
   - 没找到 → 挂用户的默认项目，`agentHost = A`，daemon 按现有回退链决定 cwd。默认项目若绑定在 A 以外的 daemon 上则 409（挂上去会把 AI 钉到那台机器）；绑定在 A 上可以，但它的目录不是本仓库的副本，不作为"只读本地副本"告诉 AI。
2. `secondProjectId = B 的项目`：列表、计数都显示在 B 下（现有展示覆盖机制）。
3. 远程工作区，按 `launch_config.worktree` 二选一（请求里的 `worktree: true` 被消费掉，不下发给 A，避免 A 在本机建 worktree）：
   - **勾选 worktree** → `launch_config.remoteWorktree`：新增 `resolveRemoteWorktreeForProject(targetProject)`，直接由 B 的项目行构建（跳过同名 sibling 查找与合并组判断），字段与 0038 完全相同；0038 现有的 `resolveRemoteWorktreeTarget` 重构为"先找 sibling，再调用它"。删除 / 归档时按 0038 清理 B 上的 worktree。
   - **不勾** → `launch_config.remoteWorkspace = { host, projectId, workspacePath, repoRoot }`：新 key，没有 `branch` / `baseRef`。刻意**不复用** `remoteWorktree`：现有清理逻辑只认 `remoteWorktree` 并按路径删除 worktree，用独立 key 从结构上保证删除任务时绝不会碰 B 的项目目录。
4. `metadata.globalBackend = { host, backend }`，供 UI 与诊断使用。
5. bootstrap：把 `buildRemoteWorktreeBootstrap` 拆成"公共操作规程"（remote exec / cp / wait 的用法与约束）+"工作区段"：
   - worktree 模式：沿用 0038 的四步（同步基线、建 worktree、symlink/submodule、切换 `-w`）。
   - direct 模式：只声明 work dir = B 的 `workspacePath`，要求先 `git status` 了解现状、不要切换分支或丢弃未提交改动。
   - 两种模式都要求先读 B 上的 `CLAUDE.md` / `AGENTS.md`；挂在默认项目（A 上无本地 clone）时去掉"本地 clone 只读"一段。

### 4. 重启、停止、清理

- 停止、日志、消息：`agentHost = A`，走现有路由，零改动。
- 重启：restart 会建后继任务。现有代码后继**不继承 `secondProjectId`**，`remoteWorkspace` 也是新 key，需要补上：源任务带 `metadata.globalBackend` 时，后继沿用 `secondProjectId`、`remoteWorktree` 或 `remoteWorkspace`、`metadata.globalBackend`（`worktree.ts` 里继承 `remoteWorktree` 的分支同样处理 `remoteWorkspace`）。已有任务重启不受"是否仍在全局后端设置中"约束（不追溯），只约束新建。
- 持续任务（persistent）新一轮：`inherit` 与跨 daemon 都保留 `remoteWorktree` / `remoteWorkspace` 并重发对应操作规程；对全局后端任务，`worktree: "new"` 在 B 上新建 worktree，`"none"` 回到 B 的项目目录，而不是在 A 本地。
- 删除 / 归档：worktree 模式按 `remoteWorktree.host` 清理 B 上的 worktree，复用 0038 的 `worktree.ts` / `teardown.ts`，零改动；direct 模式无需清理（E2E 覆盖两种）。
- Move：改 `secondProjectId` 只影响展示，不改变远程目标，沿用现有行为。

### 5. "AI 在哪台机器"的展示（低调但可找到）

- 任务卡：不新增醒目标签。worktree 模式复用 0038 已有的 `host:branch` 小标签（`TaskItem.tsx:300`，host 是 B）；direct 模式没有分支，不显示标签（与本地不勾 worktree 一致）。"AI on macmini (claude)" 放在任务卡的 tooltip 里。
- 任务详情 / 诊断信息：诊断快照已有 `agentHost`，即 AI 所在机器，无需新增。
- 设置页是唯一的"主入口"，任务列表不出现新的视觉元素。

## Implementation Plan

一个 PR，按以下顺序提交，每步带测试：

1. **偏好存储 + API**
   - `web/src/lib/user-preferences.ts`：`getGlobalAiBackends` / `setGlobalAiBackends` + normalize。
   - 新条目要求 daemon 在线且声明该后端；已保存的条目在 daemon 离线时仍保留（可删不可加）。
   - `web/src/app/api/user-preferences/global-ai-backends/route.ts`（新）+ `route.test.ts`。
2. **remote worktree 解析重构**
   - `web/src/lib/tasks/remote-worktree.ts`：抽出 `resolveRemoteWorktreeForProject`；0038 路径改为调用它（行为不变，现有测试须全过）；bootstrap 拆为公共规程 + worktree / direct 工作区段，支持无本地 clone。
   - `web/src/lib/tasks/worktree.ts`：`parseRemoteWorkspaceLaunchConfig`；重启继承处理 `remoteWorkspace`；确认清理路径不识别它。
3. **任务创建**
   - `web/src/lib/tasks/global-backend.ts`（新）：解析 `global_backend`、校验设置、选挂载项目，按 `worktree` 勾选返回 `{ mountProject, secondProjectId, remoteWorktree | remoteWorkspace, metadata }`。
   - `web/src/app/api/tasks/route.ts`：在读取项目后调用它并替换 `project`；把 `secondProjectId`、`metadata.globalBackend` 传给 `createAiTask`（已支持 `secondProjectId` 参数）。
   - 测试：`web/src/__tests__/api/tasks-global-backend-route.test.ts`（新）。
4. **重启继承**
   - `web/src/app/api/tasks/[taskId]/restart/route.ts`：带 `metadata.globalBackend` 的任务，后继继承 `secondProjectId` / `remoteWorktree` 或 `remoteWorkspace` / `metadata.globalBackend`；补测试。
5. **前端**
   - `features/user-preferences/store.ts`：全局后端读写。
   - 设置页 Devices 分区新卡片（`features/settings/components/GlobalAiBackendsCard.tsx`）。
   - `CreateTaskDialog.tsx`：Global 分组、置灰逻辑、worktree 勾选项在全局后端下保留、payload；补组件测试。
   - `TaskItem.tsx`：tooltip 追加 AI host。
6. **文档**：AI 的操作规程在 bootstrap 里，`skills/` 下无需改动；web 是 private 包，不需要 changeset。

## Test Plan

- 单元 / API（`cd web && pnpm test`）：
  - global-ai-backends：GET 默认空；PUT 正常写入、去重；非本人 host、fire host、未知后端 → 400；share token → 403。
  - `POST /api/tasks` + `global_backend`：
    - 未在设置中 → 409；A 离线 / 不支持后端 → 409；B 缺 capability → 409；B 项目非 git → 409；share token → 403；与 `remoteWorktree`（0038 入口）/ agent group 同时出现 → 409；
    - A 有合并组项目 → `projectId = A 的项目`、`agentHost = A`、`secondProjectId = B`、cwd = A 的 workspacePath；
    - A 无项目 → `projectId = 默认项目`、`agentHost = A`、`secondProjectId = B`、无 cwd；
    - A == B → 按普通任务创建，无 `remoteWorktree`；
    - 带 `worktree: true` → `remoteWorktree` 指向 B 的项目，下发的 launch_config 不含 `worktree: true`；不带 → `remoteWorkspace` 指向 B 的 `workspacePath`，无 `remoteWorktree`；bootstrap 分别含 / 不含建 worktree 步骤。
    - 删除 direct 模式任务：不产生任何远程清理命令。
  - 0038 现有 remote worktree 测试全部通过（回归）。
  - restart：后继保留 `secondProjectId` / `remoteWorktree` 或 `remoteWorkspace` / `metadata.globalBackend`。
  - CreateTaskDialog：未配置时下拉不变；配置后出现 Global 分组；离线 / 不支持项置灰；选全局后端时 worktree 勾选项仍在；提交 payload 正确。
- E2E（按 CLAUDE.md 本地流程，macmini + ubuntu 两台 daemon）：
  1. 设置中勾选 `macmini / claude`。
  2. 在一个只绑定在 ubuntu 上、macmini 没有的项目里，用 `claude @ macmini` 建任务。
  3. 勾选 worktree：任务显示在该项目下；AI 在 ubuntu 上建 worktree、改码、跑测试、提交。
  4. 重启任务：后继仍在该项目下，继续在同一 worktree 上工作。
  5. 删除任务：ubuntu 上 worktree 被清理。
  5b. 不勾 worktree 再建一个：AI 直接在 ubuntu 的项目目录改码；删除任务后项目目录原样保留。
  6. 停掉 macmini daemon：对话框中该项置灰。
  7. 回归：未配置全局后端的账号，创建任务界面与行为不变。

## Rollout

- 无 schema 变更、无新环境变量；只需部署 web。
- daemon 侧依赖 0034 / 0037 的 `remote_exec` / `remote_file` capability（旧 daemon 未声明时服务端 409，对话框可选项不受影响）。
