# stable: 单元测试孵出 3 个生产 daemon，抢身份互杀任务（2026-08-31）

## 症状

- 2026-08-31 全天多个任务被 kill：`3f6ef667`、`7ae2666b`、`06e826be`、`6ea6e9ca`、
  `9660ccfa`、`7dd6d73e`、`ee1ec829` 等。
- 用户 restart 后"仍然失败"——实际是 restart 成功拉起 Fire，几秒内又被标 killed。
- `conductor diagnose` 只报 `task_terminal / task is already killed`，无法定位。

## 根因

### 直接原因：单元测试把生产 daemon 孵了出来

`cli/test/daemon-lock.test.js` 的 `runPreflight` 用 `env: {...process.env, ...env}`
spawn 真实的 `bin/conductor-daemon.js`。测试只覆盖了 `CONDUCTOR_HOME` /
`CONDUCTOR_WS` 两个变量做沙箱。

而这个测试是在**任务 `7ae2666b`「daemon 共享」的 Fire shell 里**跑的，该 shell 按
设计携带生产凭据。泄漏进程的环境证据：

```text
CONDUCTOR_TASK_ID=7ae2666b-35c8-4497-ad7d-bfc40bb65440
CONDUCTOR_AGENT_TOKEN=<生产 token>
CONDUCTOR_BACKEND_URL=https://conductor.conductor-ai.top
CONDUCTOR_CONFIG=/Users/wangwang/.conductor/config.yaml
CONDUCTOR_DAEMON_NAME=macmini
CONDUCTOR_HOME=/var/folders/.../conductor-lock-preflight-p7NT6j/home
CLAUDECODE=1
```

沙箱失效的关键：`resolveConductorConfigPath` **先看 `CONDUCTOR_CONFIG`，再回退
`$CONDUCTOR_HOME/config.yaml`**（`cli/src/conductor-paths.js:49-53`）。任务 shell
里 `CONDUCTOR_CONFIG` 是绝对路径，直接压过了临时 `CONDUCTOR_HOME`。于是 preflight
加载了**真实 config**（`daemon_name: macmini`）+ 继承了**生产 token**，成为一个功能
完整的生产 daemon。

三个测试用例 → 三个临时目录（`AF01ax`/`p7NT6j`/`UsiILe`）→ **三个流氓 daemon**
（PID 28441/28529/28619），全部于 `00:06:16` 启动，存活至 `20:16` 被清理，共 20 小时。
测试 fixture 的 `finally` 只 kill 了 `victim`，不回收 preflight 自己 daemonize 出的
子进程；`fs.rmSync(root)` 删掉的目录还被存活的 daemon 重建了。

讽刺点：任务 `7ae2666b` 孵出的 daemon，最后杀死的正是 `7ae2666b` 自己。

### 放大器：reconcile 只信内存，不查 tmux（第三次复发）

4 个 daemon（3 流氓 + 1 合法 PID 32026）同名 `macmini` 连同一后端。后端每个 agent
只保留一条 WS，新连接顶掉旧连接 → 被顶掉的 10s 后重连再顶回去 → **约 2 秒一轮的
乒乓风暴**（`close_code=1005`，`last_presence_at=never`）。

每次重连触发 `reconcileAssignedTasks`：

```js
const getActiveTaskIds = () => [
  ...new Set([...activeTaskProcesses.keys(), ...activePtySessions.keys()]),
];
```

纯内存判定。刚连上的 daemon 内存表是空的 → `localActive=0` → 把所有
`agent_host=macmini` 的 running 任务全判为 stale → PATCH `killed`。日志里两边视角
互为镜像：

```text
主 daemon:     backendAssigned=1 localActive=0 markedKilled=1
流氓 daemon:   backendAssigned=0 localActive=1 markedKilled=0
```

这解释了"restart 还是失败"：流氓 daemon 17:43 确实成功 restart 了 `7ae2666b`
（`Fire restart launched in detached tmux session`），但主 daemon 一重连就把它标
killed，随即 `Tmux session ... ended; backend already killed, no report needed`。
**不是启动失败，是启动后秒级被另一个 daemon 杀掉。**

daemon 关闭时**故意**保留 tmux Fire（`leaving tmux-detached Fire task ... running`），
启动/重连却没有任何认领路径——这个自相矛盾在

- `claw/issues/stable_task_836520ca_worktree_dangling_symlink_restart_fail_20260723.md`
- `claw/issues/stable_tasks_6c4df1c9_2fc582e1_reconcile_kill_symlink_restart_fail_20260731.md`

已两次记录为建议项，均未进入实现。本次是第三次复发。

## 修复状态：尚未落地

**本次只提交文档，代码修复全部回退，留待单独评估。**
方案、已验证的补丁全文、E2E 结论都记在
`claw/tasks/todo/008_P1_2d_daemon-adopt-tmux-fires-on-startup.md`。

待修的三处：

1. `cli/src/daemon.js` — `recoverStaleTasks()`（启动路径）和
   `reconcileAssignedTasks()`（重连路径）在 PATCH killed 前都要查 tmux 存活。
2. `cli/test/daemon-lock.test.js` — `runPreflight` 白名单式构造 env，剥离生产身份变量。
3. `cli/test/daemon-lock.test.js` — fixture 回收 preflight 泄漏的 daemon 并加断言。

### 本地 E2E 已验证的结论

隔离环境（`localhost:6152` + 独立 `CONDUCTOR_HOME` + 独立 `daemon_name` + 剥离生产
环境变量）实测候选补丁：

| 场景 | 无补丁 | 有补丁 |
| --- | --- | --- |
| tmux 会话存活 | `killed` ❌ | `running` ✓ |
| 无 tmux 会话（真死） | `killed` ✓ | `killed` ✓ |
| 孤儿会话（壳活、fire 已死） | `killed` | `running` ⚠️ 卡住 |

两个必须记住的点：

- **只改 `reconcileAssignedTasks` 一处不够**——E2E 里任务照样被杀，凶手是
  `recoverStaleTasks()`。启动路径才是"daemon 重启遗留 Fire"的主场景，而且它
  连 60s 宽限期都没有。差点漏掉。
- 候选补丁只做"不杀"、没做"认领"，所以孤儿会话会让任务永久卡在 `running`
  （没有 watcher 上报终态）。这是真实的行为退化，不是零成本修复。

## 线上恢复

1. `kill -TERM 28441 28529 28619` 清除三个流氓 daemon，仅保留合法的 PID 32026。
2. 观察 5 分钟：断连 0 次、重连 0 次、markedKilled 0 次（清理前约 20 次/分钟）。
3. `7ae2666b` restart 后稳定 `running`，tmux 会话存活。
4. 附带清理 PID 45050——同批（`00:07:35`）泄漏的孤儿 ai-sdk worker，ppid=1，
   98% CPU 空转 20 小时。

## 下次如何避免

1. **任何 spawn 真实 daemon/fire 二进制的测试，必须白名单式构造 env，而不是
   `{...process.env}` 增量覆盖。** 沙箱变量之间存在优先级（`CONDUCTOR_CONFIG` >
   `CONDUCTOR_HOME`），只设一个不构成隔离。
2. **在 Conductor 任务里跑仓库测试 = 在生产凭据下跑测试。** MEMORY 里已记录
   fire/diagnose 在 0.10.0 做过同类修复（`stable_fire-explicit-config-env-override-4002`），
   但没有推广到 `daemon` 和测试套件。这类修复要按"所有会读 CONDUCTOR_* 的入口"
   横向扫一遍，而不是逐个 case 打补丁。
3. **spawn 长驻进程的测试要有泄漏断言**：用例结束前后比对进程集合，不一致即失败。
4. **reconcile 的存活判定不能只信单进程内存。** 凡是"进程外仍可存活"的执行载体
   （tmux / launchd / systemd），判 stale 前必须查真实载体。
5. **同名 daemon 应在后端侧被拒绝或告警**，而不是静默顶号——顶号 + 内存式 reconcile
   的组合会把"重复上线"直接放大成"批量误杀"。
6. 排查此类问题的最快路径：`lsof -nP -p <pid> -a -i` 数一下到底有几个进程连着生产，
   再 `ps eww` 看它们的 `CONDUCTOR_*` 环境。日志里的 `localActive=0` +
   `close_code=1005` 短周期循环就是多 daemon 抢身份的指纹。
