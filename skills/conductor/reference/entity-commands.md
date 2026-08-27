# conductor project / issue / task 使用说明

这一组命令把 Conductor 的三大核心实体（project / issue / task）暴露成可脚本化的 CLI 操作，主要面向两类调用者：

1. **AI Agent**：在 shell 里通过 `--json` 输出读结构化结果、用 `--dry-run` 预演写操作
2. **人类用户 / CI**：把 issue 状态扭转、消息分发塞进自动化流水线

设计文档：`claw/rfc/0025-feature-cli-entity-commands.md`。

## 1. 顶层概览

```bash
conductor project <sub> [...]   # list / show / current / create / set-default / hide / unhide
conductor issue   <sub> [...]   # list / show / create / update / start / done
conductor task    <sub> [...]   # list / create / show / send / insert / messages / schedule
```

三组命令背后统一走 `modules/conductor-sdk` 的 `BackendApiClient`，鉴权复用 `~/.conductor/config.yaml` 里的 `agent_token`，不需要额外配置。

## 2. 全局 flags（写操作都支持）

| flag | 作用 |
|---|---|
| `--json` | 输出单行 JSON（机器可读，AI Agent 主用） |
| `--dry-run` | **不**发起任何写请求；打印将要发送的 `method / url / body`。`--json --dry-run` 输出形如 `{"dryRun":true,"request":{...},"note":"..."}` |
| `--project <id\|name>` | 显式指定项目，覆盖自动解析 |
| `--config-file <path>` | 指向自定义 `config.yaml`（与 `conductor daemon --config-file` 一致） |

读操作（`list / show / current / messages / schedule list`）忽略 `--dry-run`。

## 3. 退出码

| code | 语义 |
|---|---|
| 0 | 成功 |
| 1 | 通用失败（网络 / 服务端 5xx） |
| 2 | 参数错误（含服务端 400 / "Nothing to update"） |
| 3 | 鉴权失败（401 / 403） |
| 4 | 实体未找到（404） |
| 5 | 项目无法解析 |

## 4. "当前项目" 的解析顺序

写操作通常需要一个 project_id。CLI 按这个优先级解析：

1. **显式 flag** `--project <id|name>`
2. **环境变量** `CONDUCTOR_PROJECT_ID`
3. **cwd 路径匹配**
   - 有 `CONDUCTOR_DAEMON_NAME` / `CONDUCTOR_AGENT_NAME` 时：调服务端 `match-path` 接口
   - 没 daemon hint 时：在本地用项目列表的 `workspacePath` 做最长前缀匹配
4. **用户的默认项目**（`isDefault: true`）
5. 全部失败 → 退出码 5 + 可操作提示

> AI 通常显式传 `--project "$(conductor project current)"` 最稳。

## 5. 审计元数据（`metadata.audit`）

每次写操作 CLI 自动附带：

```json
{
  "metadata": {
    "audit": {
      "actor": "cli",
      "cliVersion": "0.2.42",
      "invokedBy": "<env CONDUCTOR_INVOKED_BY 或 null>",
      "sdkVersion": "0.2.42"
    }
  }
}
```

服务端 strip 任何 caller 在 **top-level** 注入的 `actor / cliVersion / sdkVersion / invokedBy`——只信任 `metadata.audit.*`，防止 `--metadata-json '{"actor":"system"}'` 这种 spoof。

需要标记调用方时（例如 Claude Code 在跑这条命令）：

```bash
CONDUCTOR_INVOKED_BY=claude-code conductor issue create --title "X" ...
```

## 6. `conductor project`

```bash
conductor project list [--include-hidden]
conductor project show [<id|name>] [--daemon-host <h>]
conductor project current
conductor project create [--name <n>] [--workspace-path <p>] [--daemon-host <h>] [--default] [--client-request-id <key>]
conductor project set-default <id|name> [--daemon-host <h>]
conductor project hide   <id|name> [--daemon-host <h>]
conductor project unhide <id|name> [--daemon-host <h>]
```

要点：

- `list` 默认隐藏 `hiddenAt != null` 的项目，`--include-hidden` 全量。
- `show` 不传参数时按 §4 规则解析"当前项目"；传名字会先尝试当 id 找，404 再去 list 里 unique-name 匹配。
- `current` 只打印 id，方便 shell substitution：`PROJECT=$(conductor project current)`。
- `create`：
  - `--workspace-path` 缺省取 cwd
  - `--name` 缺省取 `basename(workspace-path)`
  - daemon 不可达时报错并提示 `conductor daemon` 或 `--daemon-host <h>`（**不**自动拉起 daemon）
  - `--default` 创建用户的默认项目（无 binding，与所有 `--workspace-path/--daemon-host` 冲突）
- `set-default`：调 `POST /api/projects/default`，可促任意未隐藏项目（含 bound 项目）为默认。
- `hide`：默认项目会被服务端拒绝，退出码 2。

### 6.1 多 daemon 同名怎么办

`Project` 的唯一约束是 `(userId, daemonHost, name)` —— 同一用户在不同 daemon 上**允许**同名项目（这是 web 端 "merged group" 视图的根因）。`show / set-default / hide / unhide` 这四条按 `<id|name>` 解析的命令都支持 `--daemon-host <host>` 做二级筛选：

```bash
# 1) 单纯传 name，多匹配 → 退出码 2，错误里直接列候选
$ conductor project set-default persona
Error: Project name 'persona' is ambiguous (2 matches). Pass --project <id> or --daemon-host <host> to disambiguate:
  42620d1b-9460-4c36-9989-9f2d65263c5c  daemon=4090  /home/duino/ws/ququ/persona
  ced85ff7-9754-4eaa-8285-348c8a2e24ee  daemon=m1    /Users/duino/ws/ark/persona

# 2) 用 --daemon-host 精确选一个
$ conductor project set-default persona --daemon-host 4090

# 3) --daemon-host 排除掉所有候选 → 退出码 4
$ conductor project set-default persona --daemon-host nowhere
Error: No project found matching 'persona' (no match on daemon 'nowhere')

# 4) id + --daemon-host 不一致 → 退出码 2（避免误操作）
$ conductor project set-default 42620d1b-... --daemon-host m1
Error: Project 42620d1b-... is on daemon '4090', not 'm1'
```

`DefaultProject` 表是 `(userId → projectId)` 单行映射，**不能把"跨 daemon 的同名 group"作为默认** —— 默认项目永远指向某一具体 Project 行。如果你想"按 cwd 自动切换具体 daemon 行"，那是产品层 default-strategy，超出本期范围。

## 7. `conductor issue`

```bash
conductor issue list [--status <s>] [--limit N]
conductor issue show <id>
conductor issue create --title <t>
                      [--description <d> | --description-file FILE | --description-stdin]
                      [--priority P1|P2|P3] [--status backlog|doing|done]
                      [--client-request-id <key>]
conductor issue update <id> [--title ...] [--description ...] [--priority ...] [--status ...]
conductor issue start <id>             # 等价 update --status doing
conductor issue done  <id> [--evidence <text>|@FILE]
```

要点：

- `--description` / `--description-file` / `--description-stdin` 三选一。
- `--client-request-id <key>`：**幂等键**。同 `(userId, projectId, clientRequestId)` 重复 POST 直接返回旧记录（200），不创建副本，也不重发 WebSocket 广播。AI 批量建 issue 时强烈建议传，例：`--client-request-id "chat-2026-05-09-issue-3"`。
- `update`：多字段 patch 走 `PATCH /api/issues/{id}`；只有当带 `--evidence` 时走 `updateIssueStatus` 流程（SDK 先 GET 现状、merge 后再 PATCH，避免清空已有 metadata）。
- `start` / `done` 是 `update --status doing/done` 的 alias。
- `done --evidence "<text>"` 或 `--evidence @qa-report.md`，证据写入 `metadata.qa.evidence`。
- 状态联动（服务端行为）：
  - PATCH 到 `doing` 自动起 task
  - PATCH 到 `done` 自动 kill 关联 task
- 创建后服务端会通过 WebSocket 广播 `issue.created`，已打开 web 前端会自动刷新。

## 8. `conductor task`

```bash
conductor task list [--issue <id>] [--status ...]
conductor task create --title <t>
                      [--prompt <p>] [--backend <name>]
                      [--parent-task-id <id>]
conductor task show <id>
conductor task send <id> [<message>] [--stdin] [--from-file FILE] [--metadata-json '{...}']
conductor task insert <id> [<message>] [--stdin] [--from-file FILE]
                      [--target-reply-to <message-id>] [--metadata-json '{...}']
conductor task messages <id> [--limit N] [--before <msg-id>]
conductor task schedule list <id>
conductor task schedule create <id> [<message>] [--stdin] [--from-file FILE]
                               (--delay <duration> | --at <datetime> | --every <duration>)
conductor task schedule delete <id> <schedule-id>
```

要点：

- `create` 固定创建 `ai_task`，走 web 前端相同的 app-task 通路，而不是 `conductor fire` 的 fire-task 通路。
- `--title` 必填；`--prompt` 是首条 user message；`--backend` 可选，但指定后必须由目标在线 daemon 显式支持。
- `--parent-task-id` 只接受当前用户可见、未归档的 task。成功后，新 task 与 parent 在同一 task-card group 中展示。
- app task 必须绑定到在线的非 fire daemon。没有在线 daemon、只有 fire host，或没有 daemon 支持指定 backend 时，服务端返回 409，且不会写入 task。
- 分组属于创建后的展示状态。若 task 已创建但分组保存失败，命令仍返回成功并保留 task：
  - 人类可读输出会在 stderr 打印 warning。
  - `--json` 输出包含 `grouping: { parentTaskId, grouped, warning }`。
  - `grouped` 为 `false` 时不要重跑 `task create`，否则会创建重复 task。
- `create --dry-run` 会完成只读项目解析并预览 `POST /api/tasks`，但不会创建 task。
- `send` 的 `<message>` / `--stdin` / `--from-file` 三选一。
- `insert` 同样接受三种消息输入方式，但会中断正在执行的当前轮，让插入消息下一轮优先处理；`--target-reply-to` 可指定被中断轮次的 reply target。
- `messages` 只拉一段历史就退出（**不**支持 `tail -f`；要实时跟看请用 web 前端）。
- `schedule create` 的 `--delay` / `--at` / `--every` 三选一：
  - `--delay 10m` 或 `--at 2026-07-28T18:00:00+08:00` 创建一次性消息。
  - `--every 30m` 创建重复消息，可配 `--if-idle`、`--max-runs`、`--max-skips`、`--stop-at` 和 `--keep-when-task-stopped`。
  - `schedule list` 查看活动计划；`schedule delete` 删除一条活动计划。
- **Agent 调度管控**：每个任务有 `agent_schedule_access`（`full` 默认 / `read_only` / `blocked`）。当 `schedule create|list|delete` 由 daemon 启动的 fire agent 发起时会被此设置约束（`read_only` 禁 create/delete，`blocked` 连 list 都 `403`）；人类 / UI 调用永远不受限。归属靠自动附带的 `X-Conductor-Actor: agent` 头。设置与语义详见 `reference/http-endpoints.md` §3。
- `--metadata-json` 可附用户自定义 metadata，但 top-level `actor / cliVersion / invokedBy / sdkVersion` 会被服务端 strip。

### 8.1 `task create` 与 `fire` 的选择

```bash
# 新建由 daemon 执行、在 app 中管理的任务
conductor task create \
  --title "Implement parser" \
  --prompt "Build the parser" \
  --backend codex

# 新建任务并与 parent 放入同一个 task-card group
conductor task create \
  --title "Parser follow-up" \
  --prompt "Handle the remaining edge cases" \
  --parent-task-id TASK_ID \
  --json

# 托管或恢复当前终端中的本地 backend session
conductor fire --backend codex --resume SESSION_ID
```

选择规则：

- 已有本地 Codex / Claude session，要托管或恢复它：用 `conductor fire`。
- 要从 CLI 新建一个与 web 前端创建结果一致的 app task：用 `conductor task create`。
- 要继续给已有 task 发消息：用 `conductor task send`。

## 9. 三个核心场景

### 9.1 AI 聊完梳理出一批 issue → 批量建到当前项目

```bash
for i in 1 2 3; do
  conductor issue create \
    --title "Refactor module $i" \
    --description-file "/tmp/issue-$i.md" \
    --priority P2 \
    --client-request-id "chat-2026-05-09-$i" \
    --json
done
```

前端走 WebSocket 实时刷新，不需要手动 reload。重试同一条命令不会建副本。

### 9.2 doing 的 issue 通过 QA → 标 done

```bash
# 内嵌证据
conductor issue done ISSUE_ID --evidence "QA passed at 2026-05-09"

# 引用文件
conductor issue done ISSUE_ID --evidence @./qa-report.md
```

服务端把 evidence 写到 `metadata.qa.evidence` 并 kill 关联 task。

### 9.3 通过命令行给 task 发消息

```bash
# 直接发
conductor task send TASK_ID "请在你刚才的实现里加上单元测试"

# 多行/复杂内容
cat ./long-prompt.md | conductor task send TASK_ID --stdin

# 通过 issue 找其活跃 task 再发（间接路径）
TASK=$(conductor task list --issue ISSUE_ID --status running --json | jq -r '.[0].id')
conductor task send "$TASK" "follow-up question"
```

## 10. dry-run 的注意点

`--dry-run` 始终不发请求，但**项目解析**是只读的，会真实命中 GET。所以 dry-run 看到的 `body.projectId` 是真值。

`issue done --evidence` 的 dry-run 输出会带一行 `note`，提示实际 PATCH 会先 round-trip 服务端 metadata 再 merge —— 预览里只能看到 CLI 注入的部分。

```bash
$ conductor issue done I1 --evidence "ok" --json --dry-run
{"dryRun":true,"request":{...,"body":{"status":"done","metadata":{"audit":{"actor":"cli",...},"qa":{"evidence":"ok"}}}},"note":"preview omits server-side metadata round-trip; live PATCH merges existing metadata.qa fields"}
```

## 11. 常见问题

### 11.1 "Project unresolved"（退出码 5）

按 §4 的优先级链一步步排查。最快补救：

```bash
conductor project list --json | jq -r '.[].id'      # 看候选
conductor project current                            # 看当前
conductor issue list --project <id> --json           # 显式指定
```

### 11.1.1 "Project name 'X' is ambiguous"（退出码 2）

跨 daemon 同名的常见结果。错误消息会直接列候选 id + daemon。按 §6.1 用 `--daemon-host <host>` 精确选一条，或直接用 id。

### 11.2 "Daemon at <host> not reachable"（`project create` 时）

要么先 `conductor daemon`（或 `conductor daemon --nohup`）把本机 daemon 起来，要么用 `--daemon-host <existing-host>` 复用已有 daemon。CLI **不**会自动拉起 daemon。

### 11.3 "Default project cannot be hidden"

默认项目不允许 hide，按服务端约束，退出码 2。要先 `conductor project set-default <other>` 切默认项目，再 hide。

### 11.4 幂等键碰撞了怎么办？

`clientRequestId` 是 caller 责任：同一个键 + 同项目重复 POST 会返回旧记录。如果你想强制建新条目，**别**传 `--client-request-id`，或换一个新值。

### 11.5 为什么 `--metadata-json '{"actor":"system"}'` 不生效？

服务端 strip 任何顶层的 audit 字段（`actor / cliVersion / sdkVersion / invokedBy`），只信 `metadata.audit.*`。如果确实要标记 actor，用 `CONDUCTOR_INVOKED_BY=<tool-name>` 环境变量，会出现在 `metadata.audit.invokedBy`。
