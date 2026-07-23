# stable: f1114ced / d4b2f8f9 无法 restart —— worktree 悬空 symlink EEXIST 复发（2026-07-23）

## 结论先行

两个任务无法 restart 的根因与 `stable_task_836520ca_worktree_dangling_symlink_restart_fail_20260723`
**完全相同**：worktree 里 `xr/android/build/local.properties` 是一条**悬空 symlink**，
`ensureTaskWorktreeSymlinks` 用 `existsSync`（跟随链接）判定为"不存在"，随后
`symlinkSync()` 抛 `EEXIST`。restart 在 `resolveRestartCwd` 阶段异常退出，
daemon 回报 `KILLED`，任务瞬间打回 `killed`。

层级：**restart 执行层（daemon worktree 准备）**，不是路由层 / WS 层 / 主机绑定层。
诊断类型：**live**。

**这次的新事实（比 836520ca 更严重）：**

1. **修复未发布。** `cli/src/daemon.js` 里的 `lstat` 修复只存在于**本地工作区未提交**
   （`git status` = ` M cli/src/daemon.js`，`git log -S` 无任何提交）。线上 m1 daemon
   跑的是 npm released `@love-moon/conductor-cli@0.7.6`，其中仍是
   `if (existsSyncFn(linkPath))` —— 缺陷 A 实际上**没有修好**。
2. **删链接只是一次性缓解，会复发。** 有 bug 的 daemon 在 restart 成功那次会
   **重新创建同一条悬空 symlink**（源文件依旧不存在 → `symlinkSync` 成功 → 又是悬空）。
   因此**下一次 restart 必然再次失败**。836520ca 当时的"验证通过"掩盖了这一点。
3. **影响面不止 operator。** 三个项目的 `worktree.symlink` 源文件都已丢失。

## 证据

### 任务快照

| 字段 | f1114ced-… | d4b2f8f9-… |
|---|---|---|
| 标题 | pyoperator 控制 app | live feed |
| status | `killed` | `killed` |
| agent_host / execution_host | `m1` / `m1`（在线） | `m1` / `m1`（在线） |
| backend / session | `claude` / `fc987f66-…` | `codex` / `019f894f-…` |
| killed_reason | `null` | `null` |
| launch_config | worktree=true, branch=`17b44c` | worktree=true, branch=`36b994` |
| latest_status_summary | `task stopped by app: stopped_from_app` @ 03:12:48Z | 同上 @ 03:12:42Z |

路由层所有前置校验均通过：`ai_task` ✓、session 绑定 ✓、`killed` ∈ 可重启状态 ✓、
project binding `m1` == `agent_host` ✓、m1 在线 ✓、m1 支持 `claude`/`codex` ✓。
`conductor diagnose` 仅给出 `task_terminal / task is already killed`，**无任何 restart 失败线索**
（缺陷 B/C 依旧未修）。

### 对照实验（最强证据）

同一台 m1 daemon，在 12:07:41–12:07:50 **成功** restart 了 3 个任务：

```
12:07:41  Restarting task 33e1e547-… (resume_inplace -> claude)   cwd=/Users/duino/ws/conductor
12:07:43  Restarting task f2386e83-… (resume_inplace -> claude)   cwd=/Users/duino/ws/conductor
12:07:50  Restarting task c1d61685-… (resume_inplace -> codex)    cwd=/Users/duino/ws/fires/…
```

三个成功的**都不是 worktree 任务**；本次两个失败的**都是 worktree 任务**。
紧接着 12:08:04 / 12:08:23（= 两个任务的 `updated_at`）daemon 日志**一行都没有**。

### 线上复现（f1114ced）

```
before: killed
POST /api/tasks/f1114ced-…/restart {"strategy":"inplace"}  → HTTP 200
t+1s … t+6s: killed        ← 立刻打回
daemon 日志: 无 "Restarting task f1114ced" ；tmux: 无会话
```

### 悬空 symlink 与 EEXIST 复现

```
$ ls -l .conductor/worktrees/17b44c/xr/android/build/local.properties
lrwxr-xr-x → ../../../../../../xr/android/build/local.properties
$ ls /Users/duino/ws/operator/xr/android/build/local.properties
No such file or directory

existsSync (follows): false      ← 关键
lstat isSymlink     : true
fs.symlinkSync(...) → EEXIST: file already exists, symlink
```

### 反向验证（删链接 → 立刻恢复）

```
rm .conductor/worktrees/17b44c/xr/android/build/local.properties
POST restart → 200 ；t+2s..t+10s: running（不再回落）
12:15:53  Restarting task f1114ced-… (resume_inplace -> claude)
          tmux: conductor-fire-f1114ced-…-mrx00si5pgna

rm .conductor/worktrees/36b994/xr/android/build/local.properties
POST restart → 200 ；t+2s..t+10s: running
12:16:13  Restarting task d4b2f8f9-… (resume_inplace -> codex)
          tmux: conductor-fire-d4b2f8f9-…-mrx017gk38g0
```

两个任务均已恢复运行。根因确认。

### 线上 daemon 仍是有 bug 的版本

```
$ conductor --version                         → 0.7.6 (c939df2)
$ ps aux | grep conductor daemon              → node …/bin/conductor daemon --force (PID 82571)
$ grep -n 'existsSyncFn(linkPath)' \
    …/lib/node_modules/@love-moon/conductor-cli/src/daemon.js
  → if (existsSyncFn(linkPath)) {            ← released 版本仍是旧逻辑

$ git status --porcelain cli/src/daemon.js    →  M cli/src/daemon.js   （未提交）
$ git log -S "existsSync FOLLOWS symlinks" -- cli/src/daemon.js  → 空
```

### 全量扫描：还有哪些 worktree 会中招

只有出现在各项目 `.conductor/settings.yaml` 的 `worktree.symlink` 列表里的悬空链接才会触发。

| 项目 | 悬空链接（已配置） | 源文件 | 受影响 worktree |
|---|---|---|---|
| operator | `xr/android/build/local.properties` | MISSING | `17b44c` `36b994` `3e2d8c` |
| retargeting | `data/spatialmp4` | MISSING | `c6fbb3` `f856fe` |
| robotcloud | `.env.dev` | MISSING | `37b1e4` |

无害（未配置在 symlink 列表中，不会触发）：
`operator/7a2bcb` 的 `third_party/godot-cpp-build`、`third_party/ffmpeg-build`。

## 待办

1. **P0 — 把 `cli/src/daemon.js` 的 `lstat` 修复提交并发版。** 当前只在工作区，
   线上 0.7.6 无此修复，问题会无限复发。发版后 m1 daemon 需重启才生效。
2. **P0 — 恢复缺失的源文件**（治本，且不依赖发版）：
   `operator/xr/android/build/local.properties`、`retargeting/data/spatialmp4`、
   `robotcloud/.env.dev`。源文件存在则链接不再悬空，`existsSync` 分支也能走对。
3. **P1 — 缺陷 B/C 仍未修**（见 836520ca 文档）：`reportRestartFailure` 既不写本地日志、
   summary 又被 `commitTaskStatusUpdate` 丢弃，导致 `conductor diagnose` 只能给出
   `task_terminal` 这种无信息量结论。本次排查 90% 时间耗在这上面。
4. **P2 — daemon 重启误杀**（缺陷 D）：`reconcileAssignedTasks` 缺少 tmux adopt 逻辑，
   是这两个任务最初被打成 `killed` 的原因。

## 立即缓解（用户）

```bash
cd <project>/.conductor/worktrees/<branch>
find . -type l ! -exec test -e {} \; -print   # 列出悬空 symlink
rm <悬空且在 settings.yaml symlink 列表里的那条>
```

注意：**这只能撑一次 restart**，有 bug 的 daemon 会把它重新创建成悬空链接。
要根治请补回源文件，或升级到带 `lstat` 修复的 CLI。

## 下次如何避免

1. **判断 symlink 存在性一律用 `lstat`，不要用 `existsSync`。**
2. **"restart 后 200 但任务 1s 内回到 killed" = daemon 侧拒绝的强信号**，
   直接查 `handleRestartTask` 的 `reportRestartFailure` 分支。
3. **对照实验优先**：同一 daemon 同一时间窗内成功/失败任务的差异（本次是
   worktree vs 非 worktree），比逐条读路由层校验快得多。
4. **验证修复时必须验证第二次**。本次证明"删掉链接 → restart 成功"是假阳性验证：
   有 bug 的代码会把坏状态重新写回去，只测一次会误判为已修复。
5. **确认修复真的发布了**。`git status` 显示 `M` 而 `git log -S` 为空 ⇒ 修复只在工作区。
   线上跑的是 npm released 版本，不是仓库工作区。
