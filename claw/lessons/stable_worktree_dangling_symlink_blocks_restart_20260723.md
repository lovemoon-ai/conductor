# stable: worktree 悬空 symlink 让任务永久无法 restart（2026-07-23）

完整取证过程见
`claw/issues/stable_task_836520ca_worktree_dangling_symlink_restart_fail_20260723.md`。

## 症状

重启 m1 daemon 后，任务 `836520ca` 被误杀成 `killed`（这一步是已知的
reconcile 误杀）。真正的问题是**之后再也 restart 不回来**：

- restart API 每次都返回 HTTP 200，任务确实变成 `running`；
- **约 230ms 后被打回 `killed`**；
- daemon 日志一行都没有，`task_status_events` 也没有新记录；
- `conductor diagnose` 只能给出 `task_terminal / task is already killed`。

三处静默叠加，导致失败原因在全链路上完全不可见。

## 根因

`cli/src/daemon.js` `ensureTaskWorktreeSymlinks` 用
`fs.existsSync(linkPath)` 判断"这条 symlink 是不是已经建好了"。

**`existsSync` 会跟随符号链接**：当 link 的目标文件已被删除（悬空 link），
`existsSync` 返回 `false`，代码判定"还没建"，接着 `fs.symlinkSync()` 对一条
已经存在的 link 再建一次 —— 抛 `EEXIST`。

调用链：

```
handleRestartTask → resolveRestartCwd → ensureTaskWorktree → ensureTaskWorktreeSymlinks ✗ EEXIST
```

异常被 `reportRestartFailure()` 接住，它给后端发 `task_status_update=KILLED`，
任务立刻被打回。因为 symlink 源文件不会自己回来，**这个失败每次必现、永不自愈**。

本例的肇事条目是项目 `.conductor/settings.yaml` 里配的
`xr/android/build/local.properties`，源文件早就被删了。这类配置项
（`.venv` / `node_modules` / `local.properties`）本来就是 gitignore 的易变产物，
源文件消失是常态。

## 为什么原因看不见（两个次生缺陷）

1. `reportRestartFailure()` 全程不写本地日志。它上面几个 return 分支
   （unsupported backend、cwd 解析、worktree 准备）都发生在
   `log("Restarting task …")` **之前**，所以 daemon 日志是完全空白的。
2. `commitTaskStatusUpdate()`（`web/src/lib/realtime/agent-upstream.ts`）
   只在带 `statusEventId` 时才写 `taskStatusEvent`，而
   `taskStatusEvent.summary` 是 `summary` **唯一**的落库位置。daemon 报失败时
   不带 `status_event_id`，于是 `restart failed: EEXIST …` 这句话直接被丢弃。

## 修复

- **A（真根因）** `cli/src/daemon.js ensureTaskWorktreeSymlinks`：探测改用
  `lstat`（ENOENT 才算不存在），并用 `readlink` 比对**链接指向**而不是
  目标是否可解析。指向正确的悬空 link 视为已就绪，直接 `continue`。
- **B（可观测性）** 双向补齐：daemon 侧 `reportRestartFailure` 补
  `status_event_id`；web 侧 `commitTaskStatusUpdate` 在 `summary` 非空时
  合成一个 id，保证任何带 summary 的上报都落成真正的 status event。
- **C（日志）** `reportRestartFailure` 增加 `[restart-spawn] failure …` 日志行。

测试：`cli/test/daemon.test.js` 新增悬空 symlink 回归用例（并修正三个旧用例里
"lstat 不该被调用"的过时断言 —— 那条断言正是把 bug 行为写死进了测试）；
`web/src/lib/realtime/agent-upstream.test.ts` 新增两个用例覆盖 summary 落库
与"无 summary 时不合成事件"。

## 补充修复 D：源不存在时不再创建链接（杜绝"先天悬空"）

修复 A 治的是"已经存在的悬空 link"，但悬空 link 从哪来还没堵住。

`symlinkSync` **不要求目标存在**（POSIX），所以一条源文件在这台机器上从未出现过的
配置项（本例 `xr/android/build/local.properties`，IDE 本地生成、必然 gitignore），
会让 daemon 在**第一次**准备 worktree 时就**主动造出一条天生悬空的链接** —— 然后
在下一次准备时被 A 的 EEXIST 绊倒。也就是说这条悬空 link 是工具自己制造的，
手动删掉也会被下次准备重新造出来。

`ensureTaskWorktreeSymlinks` 因此在 git-tracked 检查之后、计算 linkPath 之前
增加源存在性判断：源不存在则跳过，并打一行
`[worktree] skipping symlink for missing source: …`，让过期配置**可见**而不是被
静默固化成磁盘上的悬空链接（顺带也不再创建多余的父目录）。

注意两处探测的取舍是**故意相反**的，代码里都写了注释：

| 探测对象 | 关心的问题 | 用什么 |
|---|---|---|
| **源** | 是否解析到真实存在的东西（源本身是悬空 link 也没意义） | `existsSync`（跟随链接正是想要的）|
| **目标** | 这个路径上是否已有一个链接条目 | `lstat`（绝不能跟随）|

测试：`cli/test/daemon.test.js` 新增
"skips a configured symlink whose source does not exist"（断言既不 `symlinkSync`
也不 `lstat`，且 worktree 准备仍然完成）；并把三个旧用例的 `existsSync` mock
补上源路径 —— 它们此前把源当作不存在，正好会被新逻辑跳过。

## 下次如何避免

0. **别只治"悬空 link 存在时不要报错"，还要治"不要制造悬空 link"。**
   `symlinkSync` 不校验目标，任何"按配置批量建链接"的代码都必须自己先检查源；
   配置里的路径在某些机器上可能永远不存在，要**告警而不是静默**。
1. **判断 symlink 是否存在，一律用 `lstat`，绝不用 `existsSync`。**
   `existsSync` 跟随链接，对悬空链接返回 false，是 `EEXIST` 的经典来源。
   同理：判断"链接是否正确"要比 `readlink` 的**指向**，而不是目标能否解析 ——
   symlink 的正确性不该依赖目标此刻是否存在。
2. **幂等准备逻辑（worktree/symlink/目录）必须真正幂等**，且失败不能是
   "永久性"的：一次外部状态漂移就让任务永远起不来，代价过高。
3. **任何 fail-fast 分支都要同时保证：本地有日志 + 上报的 summary 能落库。**
   本次两条链路同时静默，`conductor diagnose` 才会退化成毫无信息量的
   `task_terminal`。
4. **排查口诀**：restart 返回 200 但任务 1s 内回到 killed ⇒ 一定是 daemon 侧
   `reportRestartFailure` 的某个分支，直接去看
   `handleRestartTask` 里 `log("Restarting task …")` **之前**的所有 return，
   不要在路由层 / WS 层浪费时间。
5. **测试断言不要固化 bug 行为。** 旧用例里的
   `assert.deepStrictEqual(lstatCalls, [])` 断言的是"lstat 不会被调用"，
   这恰恰是 `existsSync` 短路造成的错误行为，反过来给正确修复设了障碍。
