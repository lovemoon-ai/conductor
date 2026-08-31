# Goal

让 daemon 在启动/重连时**认领**（adopt）上一个 daemon 留下的 tmux Fire，而不是把它们
判成 stale 并 PATCH `killed`。

这个缺陷已复发三次（20260723 / 20260731 / 20260831），前两次都只在事故文档里记了
建议、没有进实现，所以第三次照样发生。事故复盘见
`claw/lessons/stable_test-spawned-rogue-prod-daemon-mass-kill-20260831.md`。

## Background

`fire_tmux_mode: true` 时，daemon 关闭是**故意**把 Fire 留活的：

```text
Daemon shutting down: leaving tmux-detached Fire task <id> (session=...) running
```

但新起来的 daemon 完全没有认领路径，`activeTaskProcesses` 必然为空。有两处会据此杀人：

| 函数 | 触发时机 | 宽限期 | 现状 |
| --- | --- | --- | --- |
| `recoverStaleTasks()` | daemon **启动** | 无 | 启动即杀光所有 `agent_host==AGENT_NAME` 的 running task |
| `reconcileAssignedTasks()` | WS **重连** | 60s (`RECONCILE_GRACE_PERIOD_MS`) | 同样只看内存 |

两者的存活判定都是：

```js
const getActiveTaskIds = () => [
  ...new Set([...activeTaskProcesses.keys(), ...activePtySessions.keys()]),
];
```

**启动路径是主场景**——"daemon 重启后遗留 Fire"走的就是它，而且它连宽限期都没有。

## 已验证的结论（不要重做这部分调研）

2026-08-31 已在本地搭 E2E 实测过一版候选补丁，结论如下，可直接复用。

### 候选补丁

在两处 kill 前插入 tmux 存活检查，跳过仍有 `conductor-fire-<taskId>-*` 会话的 task。
`listAllTmuxSessions()` 和 `buildFireTmuxSessionPrefix()` **都是现成的**（前者原本只用于
`killTmuxSessionsForDeletedTask`），不需要新增抽象。补丁全文存档：见本文件末尾。

### E2E 结果

隔离环境：`localhost:6152` 后端 + 独立 `CONDUCTOR_HOME` + 独立 `daemon_name` +
剥离全部生产环境变量。真 daemon 进程、真 tmux server、真 DB 断言。任务 `created_at`
设为 1 小时前以越过 60s 宽限期。

| 场景 | 构造 | 无补丁 | 有补丁 |
| --- | --- | --- | --- |
| A | tmux 会话存活 | `killed` ❌ | `running` ✓ |
| B | 无 tmux 会话（真死） | `killed` ✓ | `killed` ✓ |
| C | 孤儿会话（壳活、fire 已死） | `killed` | `running` ⚠️ |

- **A 证明修复有效**，B 证明**没有回归**（真死的任务照常清理）。
- **只打 `reconcileAssignedTasks` 一处时 A 仍然被杀**——凶手是
  `recoverStaleTasks()`。两处必须同时改，这是 E2E 才发现的，容易漏。

### 场景 C：这个方案的已知缺口（本任务的主要待解问题）

候选补丁只做了"不杀"，**没做"认领"**：跳过 kill 后没有把会话注册进
`activeTaskProcesses`，因此**没有 watcher 盯着它**。负责上报终态的 reaper
（`cli/src/daemon.js` 约 1770-1816）全程依赖 `record.logPath` / `record.tmuxSession` /
`record.exitMarkerToken` / `record.logStartOffset`，这些字段只有本 daemon 自己 spawn
的 Fire 才有。

后果：**tmux 会话还在但里面的 Fire 已经死了 → 任务永久卡在 `running`，没人上报终态。**
改动前这种情况会被杀掉（此时杀是对的）。

也就是说候选补丁是拿「误杀活任务」换「孤儿会话卡 running」。前者毁用户正在进行的
工作、后者可见且可 restart，交换大概率划算，但**这是真实的行为退化，不是零成本**。

## Steps

1. 先决定形态：是采纳"只跳过"的最小补丁 + 单独治理场景 C，还是直接做完整 adopt。
   建议后者——完整 adopt 同时解决 A 和 C，且是 0723/0731 两份文档原本的建议。
2. 完整 adopt 需要在启动时重建 `record`：
   - `tmux list-sessions` 枚举 `conductor-fire-<taskId>-*`
   - 从会话名反解 taskId
   - 重建 `logPath` / `logStartOffset` / `exitMarkerToken` / `spawnedAtMs`
     （关键难点：`exitMarkerToken` 是 spawn 时生成的随机量，跨进程不可复现，
     需要落盘持久化才能恢复；否则 reaper 无法判定退出码，只能退化成
     "会话消失即 KILLED"）
   - 注册进 `activeTaskProcesses` 并挂上与正常 spawn 相同的 watcher
3. 两处 kill 路径（`recoverStaleTasks` / `reconcileAssignedTasks`）都要覆盖。
4. 把 A/B/C 三个场景固化成仓库内的回归测试。**`recoverStaleTasks` 这次漏网正是
   因为没有测试覆盖**——只补代码不补测试，第四次复发只是时间问题。
5. 考虑 `recoverStaleTasks()` 是否也该有宽限期（目前无）。
6. 顺带修：`Recovered N stale task(s) to killed` 目前统计的是候选数而非实际成功数，
   HTTP 500/409 失败后仍打印"已恢复"（0731 文档已提过，仍未改）。

## Non-goals

1. 不要在这个任务里改后端。同名 daemon 顶号告警是另一件事（见下方"关联"）。
2. 不要动 `fire_tmux_mode` 之外的路径；守卫必须由 `FIRE_TMUX_MODE_ACTIVE` 把关，
   非 tmux 部署行为保持不变。
3. 不要引入 owner lease / epoch fencing（archived plan 里的设计，现状没有，
   见 `claw/architecture/task-fire-daemon.md` §2.3）。

## 关联

- 事故复盘：`claw/lessons/stable_test-spawned-rogue-prod-daemon-mass-kill-20260831.md`
- 事实源：`claw/architecture/task-fire-daemon.md` §13.5 / §13.6
- 历史复发：
  - `claw/issues/stable_task_836520ca_worktree_dangling_symlink_restart_fail_20260723.md`
  - `claw/issues/stable_tasks_6c4df1c9_2fc582e1_reconcile_kill_symlink_restart_fail_20260731.md`
- **另需单独立项**：后端对同名 `daemonName` 重复上线应拒绝或告警，而不是静默顶号。
  静默顶号 + 内存式 stale 判定的组合，会把"重复上线"直接放大成"批量误杀"——
  这是 20260831 事故损失面被放大的结构性原因。

## 附：已验证的候选补丁

```diff
--- a/cli/src/daemon.js
+++ b/cli/src/daemon.js
@@ recoverStaleTasks()
       if (staleTasks.length === 0) {
         return;
       }
 
+      // Startup is the main case the tmux hand-off exists for: the previous
+      // daemon deliberately left its Fires running, and this fresh process has
+      // an empty activeTaskProcesses by definition. Killing on that basis
+      // destroys the very sessions the hand-off preserved.
+      const tmuxSessions = FIRE_TMUX_MODE_ACTIVE ? await listAllTmuxSessions() : [];
+      const deadTasks = staleTasks.filter((task) => {
+        const tmuxPrefix = buildFireTmuxSessionPrefix(task?.id);
+        if (tmuxSessions.some((name) => name.startsWith(tmuxPrefix))) {
+          log(`Task ${task?.id} still has a live tmux Fire; skipping stale recovery`);
+          return false;
+        }
+        return true;
+      });
+
+      if (deadTasks.length === 0) {
+        return;
+      }
+
       await Promise.all(
-        staleTasks.map(async (task) => {
+        deadTasks.map(async (task) => {
...
-      log(`Recovered ${staleTasks.length} stale task(s) to killed`);
+      log(`Recovered ${deadTasks.length} stale task(s) to killed`);

@@ reconcileAssignedTasks()
       let killedCount = 0;
+      // Shutdown deliberately leaves tmux-detached Fires running, so
+      // activeTaskProcesses under-reports what is still alive on this host.
+      const tmuxSessions =
+        FIRE_TMUX_MODE_ACTIVE && assigned.length ? await listAllTmuxSessions() : [];
       for (const task of assigned) {
         const taskId = String(task?.id || "");
         if (!taskId) continue;
         if (localTaskIds.has(taskId)) {
           continue;
         }
+        const tmuxPrefix = buildFireTmuxSessionPrefix(taskId);
+        if (tmuxSessions.some((name) => name.startsWith(tmuxPrefix))) {
+          log(`Task ${taskId} still has a live tmux Fire; skipping stale kill`);
+          continue;
+        }
```

单元测试：`node --test test/daemon.test.js test/daemon-lock.test.js test/guest-daemon.test.js`
→ 163/163 通过。

## 附：另一半改动（测试沙箱，已在复盘中说明，同样未落地）

`cli/test/daemon-lock.test.js` 的 `runPreflight` 用 `env: {...process.env, ...env}`
spawn 真实 daemon 二进制。在 Conductor 任务里跑测试时会继承生产
`CONDUCTOR_AGENT_TOKEN` / `CONDUCTOR_BACKEND_URL`，且 `CONDUCTOR_CONFIG`（绝对路径）
在 `resolveConductorConfigPath` 里**优先级高于** `CONDUCTOR_HOME`，沙箱因此失效。
20260831 事故的三个流氓生产 daemon 就是这么来的。

两处待修：

1. 白名单式构造 env，剥离生产身份变量（至少 `CONDUCTOR_CONFIG` / `AGENT_TOKEN` /
   `BACKEND_URL` / `DAEMON_NAME` / `TASK_ID` / `PROJECT_ID` / `LAUNCHED_BY_DAEMON` /
   `LAUNCHER_SCRIPT` / `SUBCOMMAND` / `SUBCOMMAND_ARGS_JSON`）。
2. fixture `finally` 读 `daemon.pid` 回收 preflight 泄漏的 daemon，并加进程集合
   前后比对断言，防止回归再次把 daemon 漏到宿主机。

更广的一条：**所有 spawn 真实 daemon/fire 二进制的测试**都要白名单式构造 env，
而不是 `{...process.env}` 增量覆盖——沙箱变量之间存在优先级，只设一个不构成隔离。
