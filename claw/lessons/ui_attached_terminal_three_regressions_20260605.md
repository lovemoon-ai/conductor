# UI Bug: Attached Terminal — Wrong CWD, Fire-Host Rejection, Space Key Swallowed

## Symptom

刚上线的 "ai task create pty view" 功能上有三个用户可见问题：

1. PTY session 的工作目录没有自动切换到当前 AI task 实际运行的目录（worktree 任务下，终端落在了项目根目录而不是 worktree 子目录里）。
2. `conductor fire` 创建的 AI task 无法打开终端，报错：
   `Failed to attach terminal Agent conductor-fire-unknown-host-53658 does not support PTY tasks`
3. PTY view 里无法输入空格——按下 `Space` 没有任何反应（`Enter` 同样受影响）。

## Root Cause

三个问题对应三处不同的实现疏漏：

### 1. `inheritPtyLaunchConfigFromAiTask` 不识别 worktree

`web/src/lib/tasks/attached-terminal.ts` 里把 PTY cwd 解析成：

```ts
const cwd =
  normalizeOptionalString(aiConfig?.cwd) ??
  normalizeOptionalString(projectWorkspacePath);
```

AI task 启用 worktree 时，daemon 端实际把进程 `cwd` 放到
`<projectWorkspacePath>/.conductor/worktrees/<sanitize(worktreeBranch)>[/projectRelativePath]`，
但 AI task 的 `launchConfig.cwd` 并没有被 web 写死成那个路径（daemon 会动态算）。
所以 PTY 继承时拿到的是 `projectWorkspacePath` 主项目根目录，跟 AI 看到的目录完全不一样。

### 2. `resolveAttachedTerminalAgentHost` 直接把 fire host 当 PTY 目标

`conductor fire` 进程通过 conductor-sdk 注册成一个 agent，host 形如
`conductor-fire-<hostname>-<pid>`，但 SDK 根本没有 advertise `pty_task` capability
(`pty-runtime.ts` 里 `supportsPtyTask` 显式排除 fire host)。

旧代码：

```ts
const preferred = args.aiTaskAgentHost ?? args.projectDaemonHost ?? null;
const result = resolvePtyAgentHost({ requestedAgentHost: preferred, ... });
```

fire 创建的 AI task `agentHost = conductor-fire-...`，直接传给 `resolvePtyAgentHost`
就走到 "Agent X does not support PTY tasks" 这条 409 分支。
其实 fire 是个短命的 per-task 进程，长跑的守护进程在 `project.daemonHost`——
那才是真正能开 PTY 而且和 fire 在同一台机器、同一份 workspace 的 agent。

### 3. `TerminalView` 的容器 `onKeyDown` 把 Space / Enter 默认行为 preventDefault 掉

xterm.js 用一个隐藏 textarea 接收键盘输入，可打印字符是通过 `input` 事件触发，
最后再以 `onData` 派发。容器 `<div role="button">` 上的处理器：

```tsx
onKeyDown={(event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    terminalRef.current?.focus();
  }
}}
```

keydown 从 textarea **冒泡** 到容器，`event.target` 是 textarea、`event.currentTarget`
是容器。`preventDefault()` 会取消 keydown 的默认动作——也就是把对应的字符
写进 textarea——于是 `input` 事件不再触发，xterm 的 `onData` 永远收不到空格/回车。

容器上的 keydown 处理本意只是为了让 "tab 到容器后按 Space/Enter 把焦点转给终端"
的无障碍交互可用，不该影响终端内部输入。

## Fix

### `web/src/lib/tasks/worktree.ts`

新增 `resolveTaskWorktreeCwdFromLaunchConfig`，复刻 daemon 端
`buildTaskWorktreeRoot` + `resolveTaskWorktreeCwd` 的路径算法：

```ts
const folder = sanitizeWorktreeFolderName(parsed.worktreeBranch);
const worktreeRoot = pathApi.join(
  parsed.projectWorkspacePath, ".conductor", "worktrees", folder,
);
return parsed.projectRelativePath && parsed.projectRelativePath !== "."
  ? pathApi.join(worktreeRoot, parsed.projectRelativePath)
  : worktreeRoot;
```

### `web/src/lib/tasks/attached-terminal.ts`

1. `inheritPtyLaunchConfigFromAiTask` 先调用上面的 helper，没有 worktree 才退回
   `launch_config.cwd` / `projectWorkspacePath`：

   ```ts
   const cwd =
     resolveTaskWorktreeCwdFromLaunchConfig(aiTaskLaunchConfig) ??
     normalizeOptionalString(aiConfig?.cwd) ??
     normalizeOptionalString(projectWorkspacePath);
   ```

2. `resolveAttachedTerminalAgentHost` 在选 preferred host 时跳过 fire host：

   ```ts
   const candidateAiHost = !isConductorFireHost(args.aiTaskAgentHost) ? args.aiTaskAgentHost : null;
   const candidateDaemonHost = !isConductorFireHost(args.projectDaemonHost) ? args.projectDaemonHost : null;
   const preferred = candidateAiHost ?? candidateDaemonHost ?? null;
   ```

### `web/src/features/terminal/components/TerminalView.tsx`

只在事件真正落在容器本身时拦截 Space / Enter：

```tsx
onKeyDown={(event) => {
  if (event.target !== event.currentTarget) return; // 来自 xterm textarea 的冒泡，放行
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    terminalRef.current?.focus();
  }
}}
```

### Tests

`src/app/api/tasks/[taskId]/terminal/route.test.ts` 新增两条用例：

- AI task 绑定 fire host 时，POST `/terminal` 仍返回 201，且 PTY task 的
  `agentHost` 落在 `project.daemonHost`。
- AI task 使用 worktree 时，PTY session 与 PTY task 的 `cwd` 是
  `<workspace>/.conductor/worktrees/<sanitized branch>`。

## How to Avoid

1. **协议层共享 / 镜像 path 算法**：daemon 的 worktree 路径计算函数 (`buildTaskWorktreeRoot`)
   应在 web 端有"明确标注 keep in sync"的对应实现。任何引用 worktree cwd 的新功能
   都要走这条 helper，不要重新拼字符串。
2. **`isConductorFireHost` 是 capability gate**：每次在 web 侧处理 "AI task → agent host"
   的派生关系（不只是路由 stop / restart，也包括新 feature 如 PTY、文件浏览等），都要在设计阶段
   核对 fire host 是否能承担那个 capability。新增的 "fire-aware" 分支需要 8 个字以内的注释解释
   为什么不直接用 fire host。
3. **不要在 xterm 容器上 `preventDefault` 文本键**：任何对终端容器的 keydown 处理都必须用
   `event.target !== event.currentTarget` 这类 guard，把冒泡上来的击键放行给 xterm；
   否则 Space、Enter、字母等都会被意外吞掉。
4. **PTY 上线测试矩阵至少覆盖三组**：(a) 普通项目、(b) worktree 项目、(c) conductor fire 项目，
   缺一组就会留下今天这种"主流程通了、边缘场景报错"的回归。

## Files Changed

- `web/src/lib/tasks/worktree.ts`
- `web/src/lib/tasks/attached-terminal.ts`
- `web/src/features/terminal/components/TerminalView.tsx`
- `web/src/app/api/tasks/[taskId]/terminal/route.test.ts`

## Verification

```bash
cd web && ./node_modules/.bin/vitest run
# Test Files  145 passed (145), Tests  1228 passed (1228)
```
