# 0040 远程工作区结构化工具（`conductor remote mcp`）

## Status

Implemented（2026-09-26：CLI MCP server + daemon/fire 注入 + Claude/Codex 接入 + bootstrap prompt 提示；本地两 daemon 端到端验证通过）

## Owner

dang217

## Date

2026-09-26

## Summary

RFC 0038 的 remote worktree 里，AI 跑在 daemon A，代码在 daemon B。AI 的原生 Read/Edit/Grep/Glob 只能碰 A 的本地文件，操作 B 只能把一切包成 `conductor remote exec -- <shell>`。本 RFC 在 CLI 里提供 stdio MCP server `conductor remote mcp`，把 remote exec / remote file 包装成**启动时就绑定到目标 host + worktree** 的结构化工具（`remote_read` / `remote_edit` / `remote_write` / `remote_grep` / `remote_glob` / `remote_bash`），由 daemon 把绑定交给 fire，fire 按 backend 注入 Claude 与 Codex。

## Context

### 痛点

- **读文件**：`sed -n` 分段，AI 自己拼行号。
- **改文件**：heredoc 覆写或 `sed -i` / `python -c` 替换，转义易错，错了直接写坏文件，没有"old_string 不唯一"的安全网。
- **搜索**：`remote exec` 输出只保留末尾 64 000 字符，`rg` 大结果被截断且无法分页。
- **可靠性**：完全靠 bootstrap prompt 约束，AI 可能漏写 `-t/-w`，误改 A 的本地文件。

### 已有能力

- `conductor remote exec / cp / wait`（RFC 0034 / 0037），经后端中转，同账号限制。
- `launch_config.remoteWorktree = { host, projectId, repoRoot, workspacePath, branch, baseRef }`（RFC 0038），web 与 daemon 都能从它推出 worktree 路径。
- ai-sdk 的 Claude provider 透传 `mcpServers` / `allowedTools`；`codex app-server` 支持 `-c key=value`。

## Goals

- 远程工作区操作接近原生工具：带行号读、精确替换、结构化可分页搜索。
- 目标 host 与目录在 server 启动时固定；越出绑定根目录的路径直接拒绝。
- Claude 与 Codex 都支持；复用现有 auth 与同账号限制，不新增信任边界。

## Non-Goals

- 不替换 `conductor remote exec/cp/wait`（仍是兜底，也仍用于 worktree 创建前的 bootstrap 步骤）。
- B 侧 daemon、后端协议、数据库 schema 均不改动。
- 不做流式输出、交互式 shell。

## Options Considered

- **A. 继续强化 bootstrap prompt**：零代码，但转义和截断无法根治。
- **B. B 侧 daemon 新增结构化文件 RPC**：性能最好，但要改协议并做能力协商。
- **C（采用）. A 侧 stdio MCP server，内部复用 remote exec / remote file**：B 侧零改动，Claude/Codex 通用；代价是每次调用多一次后端往返。

## Design

### 1. 命令

```
conductor remote mcp --host <daemon> --root <dir> [--cwd <dir>] [--config-file <path>]
```

实现：`cli/src/remote/mcp.js`（手写 JSON-RPC over NDJSON stdio，无新依赖）。

- `--root`：任何工具都不能越出的目录（worktree 根）；`--cwd`：相对路径与 `remote_bash` 的工作目录（项目在 worktree 内的子目录）。
- 鉴权沿用 `loadCliConfig`：`--config-file`，或 env `CONDUCTOR_AGENT_TOKEN` / `CONDUCTOR_BACKEND_URL`。
- stdout 只承载协议；`initialize` 返回 `instructions`，说明工作区在哪台机器、优先用这些工具。

### 2. 工具

| 工具 | 实现 | 语义 |
| --- | --- | --- |
| `remote_read(file_path, offset?, limit?)` | exec：`awk` 数总行 + `sed -n a,bp \| head -c 60000` | `cat -n` 格式；按 60 000 字节分页，被截断的末行留到下一页；单行超 2000 字符截断；二进制拒绝 |
| `remote_edit(file_path, old_string, new_string, replace_all?)` | 下载（remote file）→ 本地替换 → 远端 sha256 比对 → 上传 | 缺失/不唯一即报错且不写；非 UTF-8/二进制拒绝；LF 片段自动匹配 CRLF 文件；`new_string` 按字面插入；保留文件 mode；返回改动附近带行号片段 |
| `remote_write(file_path, content)` | exec `mkdir -p` + 读已有 mode → 上传 | 新文件 0644，覆盖保留原 mode；内容不经 shell |
| `remote_grep(pattern, path?, glob?, type?, output_mode?, case_insensitive?, context?, offset?, head_limit?)` | exec：结果写远端临时文件，只回传一页 | `files_with_matches`（按 mtime）/`content`/`count`（按路径排序，分页稳定）；绝对路径输出 |
| `remote_glob(pattern, path?, offset?, head_limit?)` | exec：`rg --files -g` | 按 mtime 排序、分页 |
| `remote_bash(command, timeout_ms?, run_id?)` | exec `bash -lc`，cwd 固定 | 超时不杀进程，返回 run_id，可再调用续等；非零退出为 isError |

- 所有远端脚本以 `bash -c <script> conductor-mcp <args...>` 执行，路径与模式只作为位置参数，从不拼进脚本。
- 搜索在目标目录内对相对路径 `.` 执行（`rg` 只有这样才会按 `src/**/*.ts` 锚定 glob），再在 A 侧还原为绝对路径（兼容 GNU 的 `./x` 与 BSD grep 的 `x`）。
- 目标机无 `rg` 时退化为 `grep -rIE` / bash globstar，并在结果中注明。
- 写入/编辑拒绝符号链接（daemon 上传是 rename 覆盖，会把链接变成普通文件），提示改目标文件；哈希走 stdin，避免 GNU `sha256sum` 对特殊文件名输出加 `\` 前缀。
- 搜索中个别目录不可读（rg/grep 退出 2）但已有结果时照常返回；绝对路径的 glob 转成相对于搜索目录的模式。
- Claude 的 `allowedTools` 只在默认 bypassPermissions 下添加；用户在 allow_cli_list 里显式配置的更严格 `--permission-mode` 不被放宽。

### 3. 注入

实现：`cli/src/remote/mcp-launch.js`。

- **daemon**：`create_task` 与 `restart_task` 拉起 fire 时，若 launch_config 含 `remoteWorktree`，按与 web `resolveRemoteWorktreePaths` 相同的算法推出 `{host, root, cwd}`，放进 env `CONDUCTOR_REMOTE_WORKTREE`。该 key 属于 task-scoped env：从 daemon 自身 env 继承时剥离，tmux 模式下显式置空。
- **fire**：读取并立即从 `process.env` 删除（不泄漏进 AI 的 shell），再按 runtime backend 生成 session options：
  - Claude：`mcpServers.conductor_remote = { type: "stdio", command: <node>, args: [<cli>/bin/conductor-remote.js, "mcp", ...] }`，并加 `allowedTools: ["mcp__conductor_remote"]`（root 安装下 bypassPermissions 会降级为 acceptEdits）。
  - Codex：ai-sdk `configOverrides` → app-server `-c mcp_servers.conductor_remote.{command,args,env_vars,tool_timeout_sec=900}`。
  - 其他 backend 不注入，继续用 `conductor remote exec`。
- **凭据只走 env**：MCP 配置会出现在子进程 argv（`ps` 可见），因此 token 不进 args；Claude Code 的 stdio server 继承父进程 env，Codex 用 `env_vars` 按名字转发。显式 `--config-file` 时只传文件路径。

### 4. Bootstrap prompt

`web/src/lib/tasks/remote-worktree.ts` 只加一行："如果你有 `remote_*` 工具，它们已绑定到 `<host>:<workDir>`，worktree 建好后用它们代替下面的命令"。原 `remote exec` 协议保留：它既是 worktree 创建步骤的执行方式，也是老 CLI / 其他 backend 的兜底。因此 web 不需要按 daemon 版本或 backend 做能力协商。

## Risks

- **read-modify-write 竞态**：`remote_edit` 上传前比对远端 sha256，不一致即报错，由 AI 重读重试。
- **延迟**：每次工具调用都经后端中转；搜索与读取按页返回以减少大结果往返。
- **worktree 未创建**：`remote_bash` 在 cwd 不存在时提示先按 bootstrap 创建 worktree。

## Acceptance

- 单测 / 集成测试：`cli/test/remote-mcp.test.js`（真实 daemon exec handler + 真实 bash/rg 跑全部工具、MCP 协议、真实子进程 stdio + HTTP、注入参数）、`cli/test/remote-cp-roundtrip.test.js`（真实文件传输下 edit/write 的 mode）、`cli/test/daemon.test.js`（create/restart 的 env 与继承剥离）、`modules/ai-sdk/test/codex-app-server-transport.test.js`、`web/src/lib/tasks/remote-worktree.test.ts`。
- 端到端（2026-09-26，本地 web + 两个 daemon）：`POST /api/tasks` 带 `remoteWorktree.host` → daemon A 拉起 fire（日志 `Remote worktree tools bound to rmcp-e2e-b:…`）→ Claude 用 `remote_read` / `remote_edit` / `remote_bash` 改文件并提交到 B 的 worktree，A 的本地副本未被修改。
- Codex：app-server 以生成的 `-c` 覆盖启动 `conductor_remote` 并列出 6 个工具，token 经 `env_vars` 转发、不在 argv；因本机 Codex 账号失效，未跑模型回合。

## Open Questions

- "全局 AI 后端"上线后，绑定是否需要从"一个 task 一个 host"扩展到多 host。
