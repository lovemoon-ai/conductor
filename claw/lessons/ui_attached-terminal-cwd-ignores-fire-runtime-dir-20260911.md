# UI Bug: Attached Terminal 打开的目录与 AI Task 实际运行目录不一致

## Symptom

从 AI task attach 新的 PTY 终端后，终端的工作目录不是 AI task 实际运行的目录：

- 在项目子目录或嵌套 worktree（如 `<repo>/.conductor/worktrees/<id>`）里跑 `conductor fire`，终端落在项目根目录。
- 项目没有绑定 workspace 时，AI task 跑在 daemon 生成的 `<WORKSPACE_ROOT>/<date>/<ts>_pid_<pid>`，终端却另建了一个空的 `<ts>_pty_<id>` 目录。
- resume 的任务跑在会话记录里的目录，终端落在项目根目录。

## Root Cause

`inheritPtyLaunchConfigFromAiTask` 只能从 AI task 的 `launchConfig` 和 project 的 `workspacePath` **推算** cwd（worktree 路径 → `launchConfig.cwd` → `project.workspacePath`），服务端从来不知道 fire 真正运行在哪：

1. `conductor fire` 通过 `/api/projects/match-path` 按**路径前缀**匹配项目，子目录 / 嵌套 worktree 会匹配到父项目，`launchConfig.cwd` 记录的是父项目根目录。
2. daemon 在没有 bound path 时自己生成运行目录（非 tmux 模式下 spawn 后还会 rename），这个路径不回传服务端。
3. resume 时 cwd 从会话记录解析（`bootstrapResumeContextForFire` / `resolveSessionResumeCwd`），同样不回传。

fire 启动时其实已经把真实目录作为 `project_path` 传给 SDK 的 `bindTaskSession`，但 SDK 只写进本地 session store，没有上报。

## Fix

### `modules/conductor-sdk/src/client.ts`

`bindTaskSession` 收到显式 `project_path` 时，把它作为 `metadata.cwd` 随现有的 `PATCH /api/tasks/:id` 上报（与 `daemonName` 同一次请求；PATCH 对 metadata 是合并写入，不会冲掉其他字段）。fire 后续不带 `project_path` 的 bind 不会覆盖它。

### `web/src/lib/tasks/attached-terminal.ts` + `web/src/app/api/tasks/[taskId]/terminal/route.ts`

1. 路由改为**先**解析 PTY 目标 daemon，**再**计算 cwd。
2. `inheritPtyLaunchConfigFromAiTask` 优先使用 `metadata.cwd`，但仅当 `metadata.daemonName === agentHost`（上报 cwd 的 daemon 就是终端要开的 daemon）时才信任，否则回退原有推算链。
   这个校验防止把一台机器上的路径带到另一台 daemon：`handleCreatePtyTask` 会对 cwd 做 `mkdirSync(recursive)`，外来路径会被静默建成空目录或直接失败。触发场景：in-place restart 到另一台运行旧 CLI 的 daemon（旧 cwd 残留）、在机器 X 上用 `CONDUCTOR_PROJECT_ID` 手动 fire 绑定到 daemon Y 的项目、未绑定 daemon 的项目被分配到任意在线 daemon。
3. 删除 `resolveAttachedTerminalAgentHost` 未实际生效的 `ptyLaunchConfig` 参数（继承的配置只含 cwd/env/shell，不影响选 host）。

## Known Limitation

手动 `conductor fire` 解析出的 daemon name 与运行中的 daemon 不一致时（fire 用了不同的 config 文件，或 config 未写 `daemon_name` 而两边 shell 的 `CONDUCTOR_DAEMON_NAME` 不同），校验不通过，终端回退旧逻辑，不比修复前差。这种名字不一致本身已会让项目匹配落到默认项目，属于既有问题；在 fire 启动时提示名字不匹配的功能暂缓。

daemon 拉起的 fire 不受影响：daemon 注入同一个 `CONDUCTOR_CONFIG` 和 `CONDUCTOR_DAEMON_NAME=AGENT_NAME`，两边名字解析顺序一致（config 文件 → 环境变量 → hostname）。

## How to Avoid

1. **上报优先于推算**：需要知道任务真实运行位置的功能（终端、文件浏览、诊断），优先用运行进程上报的事实，launch_config 推算只作兜底。
2. **本机路径必须和 host 绑定**：路径只在产生它的机器上有意义。任何把路径发往 daemon 的逻辑，都要确认路径来源 host 与目标 host 一致，否则回退到目标 host 自己的路径。
3. **警惕 `mkdirSync(recursive)` 掩盖错误**：daemon 会为 PTY cwd 自动建目录，错误路径不会报错而是生成空目录，review 时要检查 cwd 来源。
4. **attach 终端测试矩阵**：普通项目、worktree 项目、子目录 / 嵌套 worktree 下的手动 fire、未绑定 workspace 的项目、resume 任务、跨 daemon in-place restart。

## Files Changed

- `modules/conductor-sdk/src/client.ts`
- `modules/conductor-sdk/tests/conductor_client.test.ts`
- `web/src/lib/tasks/attached-terminal.ts`
- `web/src/app/api/tasks/[taskId]/terminal/route.ts`
- `web/src/app/api/tasks/[taskId]/terminal/route.test.ts`

## Verification

```bash
cd web && npx vitest run src/lib/tasks src/app/api/tasks src/__tests__/api
# Test Files 39 passed, Tests 456 passed
cd modules/conductor-sdk && pnpm test
# Test Files 16 passed, Tests 148 passed
cd cli && node --test test/fire.test.js
# tests 85, pass 85
```
