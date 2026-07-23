# stable: branch/fork 任务瞬死且无任何诊断（fork-spawn 黑盒）(2026-07-23)

## 症状

从线上任务 `836520ca-80f7-474f-a1e2-9c19eb459256`（codex）branch 出新任务
`edd6dbe4-ee59-45ab-9029-78ab391f7b5c`（claude，换后端），新任务创建后**立即变成
`killed`**，从未真正执行。

## 线上取证

| 证据 | 值 |
|---|---|
| `killed_reason` | `fire_exit` |
| `killed_at - created_at` | **352 ms** |
| backend | codex → claude（跨后端 branch）|
| messages | 只有 handoff 提示气泡，**零 assistant 输出** |
| `resume_context_url` | `https://conductor-ai.top/share/…/plain`，有效且公网可达 |
| `restart_task` outbox | `acked`（attempt 1，无 error）|
| daemon 日志 | 全机搜 `edd6dbe4` / 对应 tmux session **零命中** |

关键交叉验证：同一 daemon、几乎同一时刻的普通 `create_task` claude 任务
`33e1e547` 正常 `running`；其它 claude 任务也都正常。**只有走 fork 的那个瞬死。**

## 最可能的真实抛错点（与同日独立排查交叉印证）

同日另一份排查 `claw/issues/stable_task_836520ca_worktree_dangling_symlink_restart_fail_20260723.md`
针对**同一个源任务 / 同一个 worktree `3e2d8c`** 定位到：

```
handleRestartTask → resolveRestartCwd → ensureTaskWorktree
    → ensureTaskWorktreeSymlinks      ← 抛 EEXIST
```

`ensureTaskWorktreeSymlinks` 用 `existsSync(linkPath)` 判断 symlink 是否存在，而
`existsSync` **会跟随符号链接**，于是一条**悬空 symlink** 被判定为"不存在"，接着
`symlinkSync()` 抛 `EEXIST`；restart 在 cwd 解析阶段就异常退出，任务在
~230ms 内被打回 `killed`，**daemon 日志一行没有、taskStatusEvent 也没有**。

这与本次 `edd6dbe4` 的签名完全一致（352ms、无日志、无 statusEvent、零输出、
笼统 `fire_exit`、同一 worktree）。因此 branch 瞬死**几乎可以确定是同一个悬空
symlink EEXIST**，而不是 claude 后端本身的问题——只是当时没有任何观测手段能看到它。

真正的功能修复（`existsSync` → `lstat` 语义，以及"源不存在就不建链接"）已单独提交，
见 `claw/lessons/stable_worktree_dangling_symlink_blocks_restart_20260723.md`。
**本补丁只负责让这类失败在下一次发生时可见**——这也是当初排查花掉大量时间的原因。

## 根因（本次事故）

**不是** reconcile / stale-recovery 误杀（那会是 `user_stopped` 或
`daemon_disconnected`，且时间尺度是 30s/60s/120s），**不是** handoff URL 拉取失败
（352ms 根本来不及 fetch），**不是** claude 后端本身坏。

真实链路：**跨后端 branch 由 daemon 的 fork spawn 路径去起一个全新 claude 后端，
该后端在启动瞬间就退出**（fire_exit / 352ms）。

而真正让这个问题"查不下去"的，是一个**可观测性黑洞**：

1. `reportRestartFailure` 只发 `task_status_update(KILLED)`，**不写 daemon 日志**。
   多个早期 reject（unsupported backend、cwd 解析、worktree 准备）发生在
   `Restarting task …` 日志行之前就 return，daemon 日志因此完全静默。
2. 子进程退出时 summary 只有 `exited with code N`，**不包含子进程实际打印的错误**。
3. 非 tmux（bridge）模式下 `shouldDaemonReportFireChildTerminalStatus` 还会
   **抑制**终态上报，连这条笼统 summary 都不发。

结果：线上只剩一个笼统的 `fire_exit`，DB 和日志里都没有"claude 为什么退出"的任何线索。

## 本次修复（观测补丁，零行为变更）

`cli/src/daemon.js`：

1. 新增 `createChildOutputCapture()`：为 spawn 出来的 fire 保留**有界（4000 字符）
   输出尾巴**，用 `maskHandoffUrlForLogs` 脱敏后可取 tail。
   - 脱敏是必须的：handoff prompt 里带 share token，后端失败时若回显 argv，
     会把整份 transcript 的读权限泄漏进日志和 DB summary。
   - 独立于 `logStream` 挂载：日志文件打不开时（`createWriteStream` 抛错）恰恰最需要它。
2. `reportRestartFailure` 增加 `[restart-spawn] failure task=… mode=…: <err>` 日志，
   **保证任何 restart/fork 失败都在 daemon 日志留痕**。
3. 子进程异常退出时输出 `[fork-spawn] abnormal exit` 诊断行，包含
   `task / mode / backend / cwd / tmux / exit / signal / lifetime_ms / log / output_tail`。
4. 终态上报的 summary 由 `exited with code 1` 增强为
   `exited with code 1: <脱敏后的输出尾巴>`。
5. **给失败/终态上报补 `status_event_id`（关键）**：此前 daemon 从不发
   `status_event_id`（全文件 0 处），而 web 的 `commitTaskStatusUpdate` **只有在
   `statusEventId` 存在时才写 `taskStatusEvent`**——那是 `summary` 唯一的落库位置。
   因此过去所有 daemon 上报的失败原因都在链路上蒸发（这正是排查时
   `task_status_events` 对 `edd6dbe4` 为空的原因）。补上之后，失败原因才真正
   进入 DB、`conductor diagnose` 和 UI。

效果示例：

```
[fork-spawn] abnormal exit task=… mode=fork_to_new_task backend=claude cwd=… \
  tmux=… exit=1 signal=null lifetime_ms=12 log=… \
  output_tail="Error: not logged in. Run `claude login`. argv: --backend claude -- \
  http://localhost:6152/share/<masked:…oken>/plain"
```

## 已知残留（未修）

- **非 tmux bridge 模式仍会抑制终态上报**，此时只有 daemon 日志携带诊断。
  改这个属于行为变更，本补丁刻意不动。
- **claude 在 daemon fork 路径下瞬死的具体原因仍未定性**——需要带着本补丁复现一次
  才能拿到 `output_tail`。
- 环境层混淆项：普通 create_task 实际由**手动 fire**（`conductor-fire-unknown-host-*`）
  执行且正常，而 branch/fork 由 **daemon 直接 spawn** 执行；本机同时存在
  `m1 / debug / qa-daemon-2` 三个 daemon 身份，路由归属混乱。

## 如何避免

- **任何"自动 kill / 失败上报"路径都必须同时留下可定位的日志**：只发状态、不写日志
  的失败路径，等于把线上问题变成不可调查事件。
- **失败 summary 必须自解释**：`exited with code N` 对排障零价值，应携带子进程输出尾巴。
- **诊断信息入库/入日志前必须脱敏**：handoff/share token 这类凭证会随 argv 回显泄漏。
- **不要只凭 `killed_reason` 下结论**：daemon 对账的 `PATCH {status:"killed"}` 会被
  task PATCH 路由改写成先进 `killing`，最终落成 `user_stopped`，看起来和用户手动停止
  完全一样（见 `stable_daemon_reconcile_split_brain_autokill_20260606.md`）。
  真正能区分的是 `fire_exit` + 生命期时长 + 子进程日志。
