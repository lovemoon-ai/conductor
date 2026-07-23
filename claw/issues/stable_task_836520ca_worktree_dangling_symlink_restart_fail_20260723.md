# stable: 836520ca 重启永久失败 —— worktree 悬空 symlink 触发 EEXIST（2026-07-23）

## 结论先行

两层问题，互相独立：

1. **被 kill 的原因**：10:35 重启 m1 daemon。旧 daemon 退出时按设计"保留 tmux
   里的 Fire 继续跑"，新 daemon 起来后 `reconcileAssignedTasks` 不认识这些
   tmux 会话，把 15 个任务全部标成 `killed`（reason 写成
   `stopped_from_app`，看起来像用户点的停止）。这是已知的
   `stable_daemon_reconcile_split_brain_autokill_20260606` 的同类问题。
2. **无法 restart 的原因（本次真正的新根因）**：
   `ensureTaskWorktreeSymlinks` 用 `fs.existsSync(linkPath)` 判断 symlink 是否
   已存在。`existsSync` **会跟随符号链接**，所以一条 **悬空（dangling）symlink**
   会被判定为"不存在"，接着 `fs.symlinkSync()` 直接抛 `EEXIST`。
   restart 在 `resolveRestartCwd` 阶段就异常退出，daemon 回报
   `task_status_update = KILLED`，任务在 ~230ms 内被打回 `killed`。
   **每次 restart 都必然复现，且永远不会自愈。**

层级：restart 执行层（daemon worktree 准备），不是路由层 / WS 层。
诊断类型：live。

## 证据

### 任务快照

| 字段 | 值 |
|---|---|
| task | `836520ca-80f7-474f-a1e2-9c19eb459256`「重构机器人约束」 |
| status | `killed` |
| agent_host / execution_host | `m1` / `m1` |
| backend / session | `codex` / `019f88b7-0773-7572-a11d-476fa3ea74d6` |
| latest_status_summary | `task stopped by app: stopped_from_app` @ 02:35:59Z |
| launch_config | worktree=true, branch=`3e2d8c`, repo=`/Users/duino/ws/operator` |

`conductor diagnose` 只给出 `task_terminal / task is already killed`，**没有任何
restart 失败线索** —— 这本身也是一个可观测性缺陷（见下）。

### kill 时间线（daemon 日志）

```
10:35:15  Daemon shutting down: leaving tmux-detached Fire task 836520ca... running   （共 15 个）
10:35:19  Daemon starting...  (pid 79821, `conductor daemon --force`)
10:35:28~58  Failed to mark stale task ... as killed: HTTP 500 / 409  ×15
10:35:58  Recovered 15 stale task(s) to killed
```

`836520ca` 的 tmux 会话随之消失，任务落到 `killed`。

### restart 失败复现

对线上直接打 restart API：

```
POST /api/tasks/836520ca-.../restart  {"strategy":"inplace"}   → HTTP 200
02:44:46.896  status=running
02:44:47.125  status=killed        （229ms 后被打回）
```

- daemon 日志**一行都没有**（`Restarting task ...` 打印在 cwd 解析之后）；
- `taskStatusEvent` 也**没有新记录**（summary 被后端丢弃，见下）。

两边都静默 ⇒ 只可能是 `reportRestartFailure()` 走到了，它既不写本地日志、
summary 又被后端吞掉。

### 定位到具体抛错点

`cli/src/daemon.js`

```
handleRestartTask
  └─ resolveRestartCwd
       └─ ensureTaskWorktree
            └─ ensureTaskWorktreeSymlinks     ← 这里抛 EEXIST
```

项目 `/Users/duino/ws/operator/.conductor/settings.yaml`：

```yaml
worktree:
  symlink:
    - .deps/src
    - xr/addons/godotopenxrvendors/.bin
    - xr/android/build/local.properties      # ← 源文件已不存在
    - ...
```

worktree `3e2d8c` 里这条 link 是悬空的：

```
$ ls -l .conductor/worktrees/3e2d8c/xr/android/build/local.properties
lrwxr-xr-x  ... -> ../../../../../../xr/android/build/local.properties
$ ls /Users/duino/ws/operator/xr/android/build/local.properties
No such file or directory
```

node 复现：

```
source exists:               false
link existsSync (follows):   false      ← 关键：悬空 link 被判定为"不存在"
link lstat isSymlink:        true
fs.symlinkSync(...)          EEXIST: file already exists, symlink
```

`ensureTaskWorktreeSymlinks` 的分支：

```js
if (existsSyncFn(linkPath)) {         // false → 整段 lstat/readlink 复用逻辑被跳过
  ...
}
symlinkSyncFn(relativeTarget, linkPath);   // ← EEXIST
```

（该条目未被 git 跟踪，`isGitTrackedWorktreePath` 的 `continue` 也救不了。）

### 验证

删掉那条悬空 symlink 后立刻重试 restart：

```
02:48:17  status=running   （不再回落）
10:48:17  Restarting task 836520ca-... (resume_inplace -> codex)
10:48:17  Resume cwd: /Users/duino/ws/operator/.conductor/worktrees/3e2d8c
10:48:17  Fire restart launched in detached tmux session: conductor-fire-836520ca-...
```

任务恢复正常。根因确认。

## 缺陷清单

### A. `ensureTaskWorktreeSymlinks` 对悬空 symlink 判定错误（真根因，必修）

`cli/src/daemon.js` `ensureTaskWorktreeSymlinks`：把
`existsSyncFn(linkPath)` 换成 `lstat` 语义。伪代码：

```js
let linkStat = null;
try { linkStat = lstatSyncFn(linkPath); } catch { /* 真的不存在 */ }
if (linkStat) {
  if (!linkStat.isSymbolicLink()) throw new Error(`destination already exists: ${linkPath}`);
  const currentResolved = path.resolve(path.dirname(linkPath), readlinkSyncFn(linkPath));
  if (currentResolved === sourcePath) continue;      // 悬空但指向正确 → 幂等跳过
  throw new Error(`destination already points elsewhere: ${linkPath}`);
}
symlinkSyncFn(relativeTarget, linkPath);
```

要点：**"link 指向是否正确"必须用 `readlink` 比对，而不是"目标是否存在"**。
symlink 源文件（`local.properties`、`.venv`、`node_modules` 这类本来就
gitignore 的东西）随时可能被删，不该让任务永久失去 restart 能力。

### B. restart 失败原因对用户/诊断完全不可见（必修）

`web/src/lib/realtime/agent-upstream.ts` `commitTaskStatusUpdate`：
只有携带 `statusEventId` 时才写 `taskStatusEvent`；没有 `statusEventId` 时走
`db.task.update({ status })`，**`summary` 被直接丢弃**。

而 `cli/src/daemon.js` `reportRestartFailure` 发的
`task_status_update` **不带 `status_event_id`**，于是
`restart failed: EEXIST ...` 这句话在全链路上蒸发：
DB 没有、`conductor diagnose` 没有、UI 只看到任务瞬间变回 killed。

修法（二选一或都做）：
- daemon 侧：`reportRestartFailure` 补 `status_event_id: randomUUID()`；
- web 侧：`commitTaskStatusUpdate` 在 `summary` 非空时也落一条 `taskStatusEvent`。

### C. `reportRestartFailure` 不写本地日志（必修，成本最低）

`cli/src/daemon.js:4985`：整个函数没有 `logError`。restart 失败在 daemon
日志里是完全静默的，只能靠反推。加一行
`logError(summary)` 即可，本次排查能省 90% 时间。

### D. daemon 重启把自己"故意留活"的 tmux Fire 全部 kill（背景问题）

`Daemon shutting down: leaving tmux-detached Fire ... running` 与
`reconcileAssignedTasks` 的假设直接矛盾：既然退出时刻意保留 tmux 会话，
新 daemon 启动时就应当**先扫描 `conductor-fire-<taskId>-*` tmux 会话并 adopt
回 `activeTaskProcesses`**，再做 stale 回收。当前代码没有任何 adopt 逻辑
（`grep adopt|reattach|rehydrate` 无结果）。

另注：10:46 又出现一次 `Recovered 15 stale task(s) to killed`，说明 daemon WS
在反复重连，每次重连都会再扫一遍 —— 这一路径的误杀是高频的。

补充：这些 PATCH 全部返回 HTTP 500/409 却仍打印 `Recovered 15 stale task(s)`，
计数与实际结果不符，日志本身也有误导性。

## 立即缓解（用户）

任一 worktree 任务重启后立刻回到 killed 时：

```bash
# 找出 .conductor/settings.yaml 里 worktree.symlink 配置的悬空链接并删除
cd <project>/.conductor/worktrees/<branch>
find . -type l ! -exec test -e {} \; -print   # 列出悬空 symlink
rm <悬空 symlink>
```

然后再点 restart。

## 下次如何避免

1. **判断 symlink 存在性一律用 `lstat`，不要用 `existsSync`。**
   `existsSync` 跟随链接，对悬空链接返回 false，是这类 EEXIST 的经典来源。
2. **任何"静默失败"路径都要同时保证：本地日志 + 上报 summary 能落库。**
   本次两条链路同时静默，导致 `conductor diagnose` 只能给出
   `task_terminal` 这种无信息量的结论。
3. **"restart 后 200 但任务在 1s 内回到 killed"是 daemon 侧拒绝的强信号**，
   排查时直接去看 `handleRestartTask` 里所有 `reportRestartFailure` 分支，
   不要在路由层/WS 层浪费时间。
4. **daemon 重启前**，若不想让在跑的任务被误杀，先确认新 daemon 有 adopt
   能力；当前版本没有，重启 daemon 必然误杀所有 tmux-detached Fire 任务。
