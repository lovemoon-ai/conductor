# 0038 跨 daemon 远程工作区（remote worktree）

## Status

Implemented（2026-09-12，后端 + CLI + 端到端验证；前端入口未做）

## Owner

dang217

## Date

2026-09-12

## Summary

同一个项目同时绑定在多台 daemon 上（例如 `macmini` 和 `ubuntu`，界面上已按"同名 + 同 `gitRemoteUrl`"合成一张卡）。本 RFC 允许一个 AI task **在 daemon A 上运行 AI**（A 有出网条件和账号），而它的 **git worktree、构建、测试都落在 daemon B 上**（B 有运行环境）。

做法：后端在 task 的 `launch_config.remoteWorktree` 里描述 B 上的仓库和分支参数，并向 AI 注入一段操作协议；AI 用已有的 `conductor remote exec / cp / wait` 在 B 上**自己创建 worktree** 并完成全部文件、git、构建操作。conductor 不新增 WebSocket 事件、不改数据库 schema，B 侧 daemon 零改动，A 侧 daemon 零改动。

前置条件（已落地，见 changeset `cli-remote-wait-and-retry`）：`conductor remote wait` 动词、`exec` 对 429 的退避重试、`exec`/`wait` 对 SIGINT/SIGTERM 的处理。

## Context

### 需求

- 有些 AI 工具（Claude Code、Codex）需要翻墙，有些机器不具备翻墙条件；而运行环境（编译、测试、硬件）在不能翻墙的机器上。
- 两台机器之间不能 SSH、不能直连。这正是 `conductor remote`（RFC 0034 / 0037）存在的原因：经 conductor 后端中转。
- Claude Code 和 Codex 都要支持。

### 现状（阻碍这件事的三个耦合）

1. **`agentHost` 必须等于 `project.daemonHost`**。`POST /api/tasks` 对非 fire host 的不一致直接 409（`web/src/app/api/tasks/route.ts:740`），restart 同样（`restart/route.ts:385-401`）。
2. **worktree 由 daemon 在拉起 AI 之前创建**（`cli/src/daemon.js:3160 ensureTaskWorktree`），分支名和基线由 web 生成后放进 `launch_config`，daemon 按 `<workspacePath>/.conductor/worktrees/<branch>` 复算路径。但这是 **`launch_config.worktree: true` 才开的可选项**，默认关闭时 task 直接跑在 `project.workspacePath`。
3. **所有路径只在生成它的机器上有意义**。代码里已有两处显式守卫：跨 daemon 重启时清空继承的 `cwd`/worktree 字段（`restart/route.ts:849-871`），附属终端只信任 `metadata.daemonName === agentHost` 时上报的 `metadata.cwd`（`attached-terminal.ts:514`）。

### 已有能力

- `conductor remote exec -t <daemon> -w <dir> -- <argv>`：无 shell、无 stdin、无流式，输出保留末尾 64 000 字符，默认 60 s 后进程在远端继续跑并返回 runId；`conductor remote cp`：SCP 语义的文件传输；`conductor remote wait -t <daemon> <runId>`：续等。
- task 的 shell 里带着 `CONDUCTOR_AGENT_TOKEN` / `CONDUCTOR_BACKEND_URL`（`daemon.js:7621-7639`），AI 今天就能直接调用 `conductor remote`，目标是同账号下任意在线 daemon。
- 注入 prompt 的先例：多 agent 的 `buildAgentBootstrap`（`web/src/lib/tasks/agent-group.ts:151`）把一段引导前置到用户第一条消息；Claude 的 `systemPrompt` 选项已经透传但无人使用（`modules/ai-sdk/src/providers/claude-agent-sdk-session.js:767`）；Codex 没有 system prompt 入口，只有用户轮、cwd 里的 `AGENTS.md` 和环境变量。

## Goals

- 一个 task：AI 在 A，工作区在 B；像本地项目一样开分支、改代码、跑测试、提交。
- 不改 schema、不加协议事件、两侧 daemon 不改。
- 删除 / 归档 task 时，B 上的 worktree 能被清掉。
- Claude Code 与 Codex 同一套机制。

## Non-Goals

- 不做后端中转的出网隧道（下文方案 A）。
- 不把 AI 的原生 Read/Edit 工具远程化（MCP 文件系统等）。
- 多 agent 组（reviewer 复用 worker worktree，`worktreeReuseOnly`）一期不支持。
- 前端交互一期不做，API 可用即可。
- worktree 的附加准备（`sync_branch`、submodule、`.conductor/settings.yaml` 的 symlink）不由 conductor 自动完成，由 AI 按协议完成。

## Options Considered

### A. 后端中转出网流量（AI 在 B 跑，只借 A 的网络）

- 优点：AI 原生体验，所有工具能力不打折；一套机制覆盖所有 CLI。
- 缺点：要新开一条经后端的数据通道（RFC 0037 已论证 agent WS 没有背压、串行分发，扛不住持续大流量），模型流量全部压在后端出带宽上；登录凭证要放到 B。改 web、cli、协议三处，工作量大。

### B. SSH 端口转发

- 不可行：A、B 互不可达，也没有两边都能到的跳板。

### C. 纯 git 同步

- A 本地改、推远端、B 拉。不满足"必须在 B 的环境里干活"这个前提。

### D. AI 在 A，通过 `conductor remote` 操作 B（本 RFC）

- 优点：零协议改动，复用 `remote exec/cp/wait`；账号和网络都留在 A；Claude Code 与 Codex 通吃；worktree 的创建由 AI 后置完成，conductor 只提供参数。
- 缺点：每一步操作经后端一圈（实测 0.27 s）；AI 失去原生 Read/Edit 的结构化体验，改用 `sed -n` / heredoc；依赖 AI 遵守协议；worktree 的附加准备靠 AI。

## Proposed Design

### 1. 数据模型：`launch_config.remoteWorktree`

```json
{
  "host": "ubuntu",
  "projectId": "<B 上那条 Project 的 id>",
  "repoRoot": "/home/duino/ws/conductor",
  "workspacePath": "/home/duino/ws/conductor",
  "branch": "f8bc83",
  "baseRef": "main"
}
```

- 与 `worktree: true` **互斥**，含义不同：`worktree` = 本 daemon 拉起 AI 之前建；`remoteWorktree` = 远端 host 上由 AI 建。用独立 key 的原因：不让 `worktree: true` 变成一个没人兑现的承诺，也让 A 的 daemon 天然跳过本地创建。
- `branch` 沿用现有 6 位 hex 生成；`baseRef` 沿用 B 的 `Project.worktreeBranch → lastCommit → HEAD`。
- 约定路径：`<workspacePath>/.conductor/worktrees/<sanitize(branch)>`，与 `buildTaskWorktreeRoot`（`daemon.js:2497`）和 `resolveTaskWorktreeCwdFromLaunchConfig`（`web/src/lib/tasks/worktree.ts:153`）一致。清理依赖这个约定。
- 不改 schema：`launch_config` 是自由 JSON，到 daemon 是原样透传（`daemon.js:671 normalizeLaunchConfig`）。

### 2. task 挂载：不破坏 `agentHost = project.daemonHost`

- task 挂在 **A 的 Project 行**（合并组里 A 的那个成员）。`agentHost = project.daemonHost = A`，创建、重启、stop、日志、终端全部沿用现有路由，一行不改。
- 后端按合并组规则（`web/src/lib/projects/grouping.ts canMergeProjectsByFields`：同名、都有 daemonHost、host 不同、`gitRemoteUrl` 一致）从 A 的项目找到 B 的 Project 行，取 `repoRoot / workspacePath / worktreeBranch / lastCommit`。
- 一期要求 A 也绑定了这个项目（即两者在同一合并组）。原因：AI 的 cwd 用 A 的本地 clone，项目的 CLAUDE.md / AGENTS.md / skills 自然加载。A 上没有该项目时返回 409（放宽为临时目录模式是后续选项，见 Open Questions）。

曾考虑的对偶方案——task 挂在 B 的 Project 行、`agentHost = A` 破例——被否决：`agentHost = project.daemonHost` 这条不变量的依赖远不止创建和重启（`fire-routing.ts` 的 interrupt 回退、`task-filter.ts` 的按 daemon 归类、DaemonShare 的 scope 过滤、附属终端的 409 文案……），每个未来新增的"找 daemon"都要记得第三台机器，是长期税。

### 3. 创建流程（`POST /api/tasks`）

输入：`project_id`（A 的行）、`launch_config.remoteWorktree: { "host": "ubuntu" }`（调用方只给 host，其余后端填）。

校验（任一不满足 409）：

- A 在线；B 在线且声明 `remote_exec` 与 `remote_file`；两者同一 userId。
- B 的 Project 行存在、与 A 的项目是合并组成员、有 `repoRoot`。
- 不能同时给 `worktree: true`；不能带 agent group。

处理：

- 填满 `remoteWorktree`；`launch_config.cwd = A 的 workspacePath`（沿用现有非 worktree 分支，`route.ts:717`）。
- `initialContent` 前置 `buildRemoteWorktreeBootstrap(...)`（§5），与 `buildAgentBootstrap` 同一位置合入（`route.ts:677`）。
- 其余与普通 task 完全相同。

### 4. daemon 行为

- **A 的 daemon**：不认识 `remoteWorktree`，按 `launch_config.cwd` 启动——零改动。
- **B 的 daemon**：只是 `remote exec/cp` 的目标——零改动。
- 清理时（§6）B 的 `handleCleanupTaskWorktree`（`daemon.js:5806`）收到的是它已经认识的字段——零改动。

### 5. 注入给 AI 的操作协议

新文件 `web/src/lib/tasks/remote-worktree.ts`：`parseRemoteWorktreeLaunchConfig`、`buildRemoteWorktreeBootstrap`、创建校验。前置到用户第一条消息（两种 CLI 都吃这一路）。Claude 可在二期额外通过已透传的 `systemPrompt: { type: "preset", preset: "claude_code", append }` 每轮兜底。

协议内容（英文写给模型）要点：

1. **事实**：工作区在 daemon `ubuntu`，给出 `repoRoot`、`workspacePath`、`branch`、`baseRef`、`worktreePath`。本机目录是同一仓库在 A 上的本地副本，**只读**：可用于 grep、看结构；不得编辑；一个文件在远端改过之后不得再读本地副本（否则拿旧内容当锚点去改远端）。
2. **工具**：所有文件读写、git、构建、测试都用 `conductor remote exec -t ubuntu -w <dir> -- <argv>`。脚本整段作为**一个 argv** 交给 `bash -lc`，开头 `set -euo pipefail`；读文件用 `sed -n` / `rg` 分页（输出只保留末尾 64 KB）；文件传输用 `conductor remote cp`；预计超过 60 s 的命令加 `--timeout`，或远端 `nohup` 写日志再轮询；被打断后用打印出的 runId `conductor remote wait` 续等；并发不超过 6 条。
3. **第一步，必须按这个顺序和路径**：
   - `git -C <repoRoot> fetch --all --prune`；若 `<repoRoot>` 当前分支是 `<baseRef>` 且工作区干净，`git merge --ff-only @{u}`（等价 daemon 的 `sync_branch`）。
   - `git -C <repoRoot> worktree add -b <branch> <worktreePath> <baseRef>`（这一步 `-w` 用 `repoRoot`，worktree 目录尚不存在）。
   - 读 `<workspacePath>/.conductor/settings.yaml`：按 `worktree.symlink` 把源存在且未被 git 跟踪的条目软链进 worktree；有 `.gitmodules` 则 `git submodule update --init --recursive`。
   - 之后所有命令 `-w <worktreePath>`；先读远端的 CLAUDE.md / AGENTS.md。
4. **禁止**：不要经 `remote exec` 嵌套运行 `conductor`（远端会剥掉所有 `CONDUCTOR_*` 变量，用 B 自己的身份解析）；`conductor task / issue / send-file` 只在本机运行。
5. **结束**：提交到 `<branch>`；不要删除 worktree，由 conductor 清理。

### 6. 清理路由

`web/src/lib/tasks/worktree.ts`：

- `parseTaskWorktreeLaunchConfig` 保持只认 `worktree: true`（与 A 侧 daemon 对称，teardown 里 stop 的 host 因此不会被带偏）。
- `requestTaskWorktreeCleanup` / `buildTaskWorktreeCleanupOutboxData`：存在 `remoteWorktree` 时，目标 host = `remoteWorktree.host`，payload 里的 `launch_config` 翻译成 B 的 handler 认的字段：`{ worktree: true, worktreeId, worktreeBranch: branch, projectRepoRoot: repoRoot, projectWorkspacePath: workspacePath }`。B 侧按现有逻辑复算路径、`git status --porcelain`、`git worktree remove`，`isSafeTaskWorktreeRoot` 守卫照常生效。
- 四个触发点已有（DELETE `/api/tasks/[id]`、archive 的 `teardown.ts`、显式 `POST /api/tasks/[id]/worktree`、删除项目时的批量清理 `api/projects`），只需让它们对 `remoteWorktree` 也触发。除显式路由外都走 outbox，B 离线时等它上线；显式路由沿用"daemon 不在线 409"。
- `hasSameTaskWorktreeRoot` 把 `(host, workspacePath, branch)` 纳入比较，fork 后继任务共享同一远端 worktree 时不误清。

### 7. 重启 / fork

- `inheritTaskWorktreeLaunchConfig`（restart 路由、`inplace-restart.ts`）把 `remoteWorktree` 原样继承给后继任务。
- fork 的 handoff 转录里包含带协议的第一条消息，规则随之传递；`refresh_session`（同一 task 换新 session）目前**不会**重新注入协议，列为后续项。
- 跨 daemon 重启（把 AI 换到 C）：`remoteWorktree` 描述的是 B，与 A 无关，保留；`cwd` 被现有逻辑清空，行为正确。

### 8. 附属功能

- 附属终端：一期开在 A 的本地 clone（现状）。二期让 `resolveAttachedTerminalAgentHost` 认 `remoteWorktree.host`，cwd 用约定路径。
- 任务卡分支标签：读 `remoteWorktree.branch`，显示为 `ubuntu:f8bc83`（前端一期不做）。
- 诊断 / fire 日志：在 A，不变。

## 实验数据

2026-09-11，`macmini` → `ubuntu`，经生产后端，CLI 0.12.0 + 本 RFC 前置的 CLI 改动。

| 项目 | 结果 |
|---|---|
| 单条命令延迟 | 0.27 s（`true`，连测 3 次） |
| 退出码 | 原样透传；命令不存在 → 255 + ENOENT |
| `-w` 指向不存在目录 | 明确报错 |
| 读 285 KB 文件 | 只留末尾 64 000 字符，stderr 有截断提示，`--json` 有 `truncated: true` |
| heredoc 写文件（双/单引号、反引号、`$HOME`、反斜杠、中文、tab） | 整段脚本作一个 argv 传 `bash -lc`，远端 sha256 与本地一致 |
| python heredoc 精确替换 | 正常 |
| `cp` 133 KB 往返 | 2.2 s，字节一致 |
| `--timeout 5s` 跑 `sleep 25` | 5.3 s 返回 runId，远端继续跑；`remote wait` 续等成功 |
| 12 条并发 | 修复前 4 条 429 失败；修复后 12 条全部成功 |
| CLI 被 SIGTERM | 修复前远端变孤儿；修复后带 `--kill-on-timeout` 远端被取消，不带则打印 runId 与 `wait` 提示 |
| 真实 worktree 流程 | `worktree add -b` 0.4 s → 按 `settings.yaml` 建 symlink → 编辑 → commit → worktree 内跑 `node --test`（18 pass，0.44 s）→ `worktree remove` + `branch -D`，全部正常 |

两个踩坑，都进了 §5 的协议：

1. **基线陈旧**：ubuntu 上次 fetch 是 8 月 28 日，从它的 `main` 切出的 worktree 里没有两周内新增的文件。daemon 自己建 worktree 时 `sync_branch` 会先 fetch + ff-merge，AI 漏了这一步。
2. **`bash -lc` 里中间一步失败、退出码仍是 0**：没加 `set -e`。

## Risks

- **AI 不守协议**。本地误改只污染 A 的 clone 工作区，不会进入远端分支，`git status` 可见；worktree 路径或分支名改动会让清理找不到目标，造成 B 上泄漏。缓解：协议里把路径写成"必须"；二期可在 B 的清理 handler 里追加 `git worktree prune`。
- **基线陈旧**：协议要求先 fetch + ff-merge，前提是 B 能访问代码托管（已确认 ubuntu 可以）。
- **延迟与并发**：每步 0.3 s 是固有代价；8 并发上限由 CLI 退避 + 协议限并发共同兜底。
- **权限边界**：无新增。task 里的 AI 持 A 的完整 agent token，今天就能 `remote exec` 到同账号任意 daemon（RFC 0034 已接受）。
- **单 web 实例**：`realtimeHub` 是进程内单例，沿用 RFC 0034 的限制。

## Rollout

1. CLI（已完成）：`conductor remote wait`、`exec` 的 429 退避重试、SIGINT/SIGTERM 处理；skill 文档 `skills/conductor/reference/remote.md` 已补协议要点。
2. 后端（已完成）：`lib/tasks/remote-worktree.ts`（目标解析 + 协议 builder）、`tasks/route.ts`（校验、注入、`remoteWorktree` 落盘）、`worktree.ts`（解析、身份比较、清理计划、继承、即时投递）、DELETE / teardown / worktree 路由、restart 继承；配套路由与单元测试。
3. 端到端（已完成，见下节）。
4. 前端：创建对话框加"工作区在另一台 daemon"选项，另开 issue。
5. 后续：`refresh_session` 重启后重新注入协议；附属终端按 `remoteWorktree.host` 开到 B。

## 实施记录与端到端结果（2026-09-12）

环境：本机起 web（`PORT=6153`，共用 dev 数据库）+ 两个 0.12.0 发行版 daemon `e2e-a`（项目路径 `/Users/wangwang/ws/conductor`）与 `e2e-b`（`/private/tmp/e2e/b/conductor`，同一 GitHub remote，构成合并组）。AI 为真实 Claude Code，跑在 `e2e-a`。

| 步骤 | 结果 |
|---|---|
| `POST /api/tasks`（A 的项目 + `launch_config.remoteWorktree.host = e2e-b`） | 200；`agentHost = e2e-a`，`cwd` = A 的 clone，`remoteWorktree` 填入 B 的 repoRoot / workspacePath / 分支（6 位 hex）/ `baseRef = main`，无 `worktree` 键 |
| AI 执行协议 | 先 `fetch` + `ff-only`，`git worktree add -b <branch> <root> main`，按 `settings.yaml` 建 `cli/node_modules` 软链（其余源不存在则跳过），提交目标文件，在 worktree 内跑 `node --test test/conductor-remote.test.js`（26 pass），回复 `DONE <sha>`；A 的本地 clone 无任何改动 |
| 首次运行耗时 | 建 worktree 到 DONE 约 3 分钟；第二次（不跑测试）约 105 秒 |
| `DELETE /api/tasks/:id` | 204；`stop_task` 发给 A 上的 fire；`cleanup_task_worktree` 发给 `e2e-b`，payload 为翻译后的本地 worktree 字段；B 在约 2 秒内 `git worktree remove`，分支保留 |

E2E 发现的一个真实缺陷（已修）：DELETE / archive 只把清理写进 outbox，投递依赖目标 daemon 自己的事件触发 drain。本地 worktree 的 daemon 同时在处理 `stop_task`，顺带就把队列清了；而 B 对这条 task 毫无感知，清理行会一直 `pending` 到 B 下次重连。第一次 E2E 正是这样：删除后 worktree 仍留在 B 上，重启 web 让 B 重连后才被清掉。修复：`deliverRemoteWorktreeCleanupNow` 在事务提交后、清理 host 与 stop host 不同时立即投递该行（本地 worktree 行为不变）。第二次 E2E 验证删除后 2 秒内清理完成。

Review 两轮补上的点：`/goal` 指令保持在首行（否则 fire 不进 goal 模式）；`daemon_share` 令牌禁止使用 `remoteWorktree`（scope 扫描器看不到这个 host 字段）；畸形 `remoteWorktree` 值返回 400 而不是忽略；删除项目的批量清理同样按 `remoteWorktree.host` 路由并立即投递；DELETE 的 worktree 分支补发 `task_deleted` 广播（原本只有普通任务分支发）。

改动清单：
- web：`src/lib/tasks/remote-worktree.ts`（新）、`src/lib/tasks/worktree.ts`、`src/app/api/tasks/route.ts`、`src/app/api/tasks/[taskId]/route.ts`、`src/app/api/tasks/[taskId]/worktree/route.ts`、`src/app/api/tasks/[taskId]/restart/route.ts`、`src/app/api/projects/route.ts`、`src/app/api/projects/[projectId]/route.ts`、`src/lib/tasks/teardown.ts`，以及对应测试。
- cli：`src/remote/wait.js`（新）、`src/remote/exec.js`、`src/remote/client.js`、`bin/conductor-remote.js`、`bin/conductor.js`、测试；changeset `cli-remote-wait-and-retry`。
- 文档：`skills/conductor/reference/remote.md`、`skills/conductor/SKILL.md`。
- 未改：数据库 schema、WS 协议、daemon、fire、ai-sdk。

向后兼容：旧 daemon 不认识 `remoteWorktree`，忽略即可；旧 web 不会产生该字段。

## Open Questions

1. A 上没有该项目时是否允许（AI cwd 用临时目录，失去 CLAUDE.md 自动加载）？
2. 是否要在 B 侧加 `prepare_task_worktree` 消息，把 symlink / submodule / sync_branch 收回 daemon 做？可靠性更高，但要加一种协议消息，且与"后置给 AI"的方向相反。
3. 附属终端一期是否直接开到 B？
4. 镜像模式（AI 在 A 的本地 worktree 上原生编辑，`git bundle` + `remote cp` 同步到 B，只把构建测试放远端）作为 plan B：触发条件是什么？
