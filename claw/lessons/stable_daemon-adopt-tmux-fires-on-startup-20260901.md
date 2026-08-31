# stable: daemon 启动/重连误杀仍存活的 tmux Fire（第三次复发后的根治，2026-09-01）

事故复盘见 `claw/lessons/stable_test-spawned-rogue-prod-daemon-mass-kill-20260831.md`。
本文只记修复本身：为什么这么修、修完后行为变了什么、下次怎么不再犯。

## 症状

daemon 重启或 WS 重连后，上一个 daemon 刻意保留的 tmux Fire 被 PATCH 成 `killed`。
用户视角是"restart 成功了几秒后又失败"，`conductor diagnose` 只报
`task_terminal / task is already killed`。

## 根因

`fire_tmux_mode` 下 daemon 关闭是**故意**把 Fire 留活的：

```text
Daemon shutting down: leaving tmux-detached Fire task <id> (session=...) running
```

但新 daemon 没有任何认领路径，`activeTaskProcesses` 必然为空。而两处 stale 判定
都只看这张内存表：

| 函数 | 触发 | 宽限期 |
| --- | --- | --- |
| `recoverStaleTasks()` | daemon 启动 | 无 |
| `reconcileAssignedTasks()` | WS 重连 | 60s |

**"关闭时故意保留"和"启动时无条件清算"是同一份代码里的自相矛盾。**
这个矛盾复发三次（20260723 / 20260731 / 20260831），前两次都只在事故文档里记了
建议、没进实现。

## 修复

### 为什么不是"查一下 tmux 就跳过"

最小补丁（kill 前查 tmux，有会话就 skip）在本地 E2E 验证过，能救活任务，但它拿
「误杀活任务」换了「孤儿会话卡 running」：跳过 kill 之后没有 watcher 盯着那个会话，
负责上报终态的 reaper 全程依赖 `record.logPath` / `record.exitMarkerToken` /
`record.logStartOffset`，而这些字段只有本 daemon 自己 spawn 的 Fire 才有。

所以做的是**完整认领**。

### 1. hand-off record（`cli/src/fire-session-registry.js`）

spawn 每个 tmux Fire 时，把 reaper 判定终态所需的字段落盘：

```
$CONDUCTOR_HOME/daemon/fire-sessions/<tmux-session>.json
{ version, taskId, projectId, tmuxSession, logPath, logStartOffset,
  exitMarkerToken, spawnedAtMs, daemonName }
```

- **关键是 `exitMarkerToken`**：per-spawn 随机 nonce，跨进程不可复现。不落盘，
  继任 daemon 就永远读不回退出码，只能退化成"会话消失即 KILLED"。
- **以 tmux session 名为 key**，因为 session 名是继任者唯一能枚举的标识
  （`tmux list-sessions`）。反过来不成立：`buildFireTmuxSessionPrefix` 把 task id
  截断到 32 字符，短于 UUID，**session 名不能反解出 task id**。
- 写入走 tmp + rename，避免被 SIGKILL 打断留下半截文件被读成"没有元数据"。
- session 名会变成文件名，所以严格校验 `^[A-Za-z0-9_-]+$`，防止 `../` 逃逸。

### 2. 启动认领（`adoptOrphanedTmuxFires`）

`client.connect()` **之前**发起，枚举 `conductor-fire-*` 会话，按记录重建 record
并注册回 `activeTaskProcesses`，挂上和正常 spawn 相同的 reaper。
不 await connect（tmux server 卡死不该拖住连接），但两处 stale 判定都
`await adoptOrphanedTmuxFiresPromise` 之后才动手——**这个先后顺序才是关键**。

顺带 prune 掉会话已消失的记录，否则注册表会按"这个 daemon 生命周期内跑过的任务数"
无界增长。

### 3. 两处 kill 路径就地认领

没有 hand-off record 的会话（旧版本 daemon 留下的），启动认领拿不到 task id。
但 `recoverStaleTasks` / `reconcileAssignedTasks` 此刻手里正好有后端返回的 task 列表，
所以在这两处按 `buildFireTmuxSessionPrefix(task.id)` 前缀匹配，**就地降级认领**
（`adoptedWithoutMetadata: true`）。会话消失时如实上报 KILLED——沉默会让任务永远
卡在 `running`，而 `reportDeadTmuxSessionStatus` 本来就有"后端已是终态则闭嘴"的
前置检查，兜住了 fire 自己上报 COMPLETED 的情况。

### 4. 孤儿会话（壳活、fire 已死）

会话还在但记录里的 exit marker 已经写出来了 = 活着的是 wrapper shell，不是 Fire。
认领它会让任务永久 `running`（reaper 只在会话消失时说话，而它永远不会消失）。
所以杀壳 + 删记录，让正常 stale 流程上报终态。

killed 过的会话名记进 `retiredOrphanFireSessions`：`tmux kill-session` 是异步的，
紧接着的一次 sweep 仍会在 `list-sessions` 里看到它，而此时记录已删——会被当成
"有活 Fire 但没元数据"重新降级认领，把任务又推回 `running`。

### 5. `record.child` 不能再当"有没有活 fire"用

**这是实现认领时最容易踩的坑，本次自审才抓到。**
被认领的 record 没有 `child`——那个 `tmux new-session` 客户端属于上一个 daemon，
早就退出了——但它指向的 Fire 活得好好的。凡是写成 `record.child` 的"已在运行"闸门
都会把它读成"这里没有 fire"：

- `handleRestartTask` 的 `else if (activeTarget?.child)`：读成 false 后**直接放行**，
  在同一个 worktree 里再起一个 Fire，两个 Fire 抢一份工作区——正是上面那段 tmux 探测
  注释里明确要防的 double-spawn。
- `handleRestartTask` 的 `refresh_session_inplace` 分支 `!activeTarget?.child`：
  读成"task is not active on this daemon"，把用户的恢复操作直接拒了。
- `handleCreateTask` 的重复 `create_task` 闸门：同一类。
- `handleStopTask` 的 `(!processRecord || !processRecord.child)`（**评审抓到，自审漏了**）：
  走"没有活进程"分支 → 上报 KILLED 但**不杀 tmux 会话**，Fire 继续在 worktree 里写东西，
  而且此后没有任何东西会发现——reaper 只在会话消失时说话。

统一成 `recordHasLiveFire(record)`（`child` 或 `tmuxMode && tmuxSession`）。
`stopActiveTaskProcess` / `handleReclaimTask` / shutdown 本来就先看 `tmuxMode`，
不受影响。

### 6. 探测失败 ≠ 什么都没在跑（**代码评审抓到的最严重一条**）

`listAllTmuxSessions()` 原本对 spawn 失败、非零退出、5s 超时**一律返回 `[]`**——
把"tmux 说没有会话"和"问不到 tmux"压成同一个值。而两处 stale 判定拿这个 `[]`
当"确实没有活 Fire"用：

**一次抖动的 tmux 探测 = 原样重演 20260831 的批量误杀。** 而且
`recoverStaleTasks()` 一个进程只跑一次，没有第二次机会纠正。

更糟的是启动 prune：`pruneFireSessionRecords(dir, [])` 会删掉注册表里**所有**记录，
于是一次瞬时探测失败会**永久**抹掉全机器所有存活 Fire 的 `exitMarkerToken`，
之后每次认领都只能降级，而降级按构造只会报 KILLED——瞬时故障被转成永久错判。

改成 `listAllTmuxSessions()` 返回 `{ sessions, conclusive }`：

- 两处 sweep 在 `!conclusive` 时**整轮跳过**，不杀任何东西；
- 启动认领在 `!conclusive` 时既不认领也**不 prune**，保留全部记录。

**同一个坑还有第二扇门**：`FIRE_TMUX_MODE_ACTIVE` 是启动时一次性的 `tmux -V`
snapshot。这个探测一旦瞬时失败（fork 压力、PATH 抖动），进程**终生**认为 tmux 不存在，
于是两处 sweep 根本不会走 tmux 查询，上面那个 conclusive 守卫连执行的机会都没有——
照样把上一个 daemon 留下的 Fire 全杀了。现在杀之前会重新探一次
（`tmuxFiresMayExistUnseen()`）：tmux 其实可达就整轮跳过。这里**故意不认领**，
因为本进程没有启动 tmux liveness reaper，认领了也没人盯；"不毁掉"就够了，
下次带着健康探测的重启会正常认领。

同一份文件里 `probeTmuxSession` 早就返回 `{alive, conclusive}`，`reapDeadTmux
SessionsOnce` 和 `handleReclaimTask` 也都拒绝在 inconclusive 上动手——新代码
一开始没沿用这个既有约定。**加新路径时先看同一文件里既有的谨慎写法。**

### 7. 降级认领不能在后端探测失败时开口

`fetchBackendTaskStatus` 对"非终态"和"问不到"都返回 `null`。普通 record 无所谓
（还有 exit marker 兜底），但 `adoptedWithoutMetadata` 的 `exitCode` 恒为 `null`，
判定恒为 KILLED——这次后端探测是"跑完的任务"和"凭空捏造的失败"之间唯一的屏障。
升级 daemon（存量会话全无记录）+ 后端部署抖动，就能把一个干净完成的任务标成
killed。现在要求拿到确切答复才开口，否则保持沉默。

### 8. 顺带修的两处

- `Recovered N stale task(s) to killed` 统计的是候选数而非实际成功数，HTTP 500/409
  失败后照样打印"已恢复"。改成 `Recovered <成功>/<尝试>`。（0731 文档提过，一直没改。）
- 两处 kill 路径都跳过 `pendingTaskStarts`——正在 spawn 中的任务同样没有 record，
  杀它等于打断自己刚起的 Fire。

### 9. 测试沙箱（事故的另一半）

`cli/test/daemon-lock.test.js` 的 `runPreflight` 用 `{...process.env, ...env}`
spawn 真实 daemon 二进制。在 Conductor 任务 shell 里跑测试时会继承生产
`CONDUCTOR_CONFIG`（绝对路径，在 `resolveConductorConfigPath` 里**优先级高于**
`CONDUCTOR_HOME`）和生产 token，沙箱因此失效。

改成白名单式构造 env（`cli/test/helpers/sandboxed-env.js`），并在 fixture 的
`finally` 里轮询 `daemon.pid` 回收 preflight 泄漏的 daemon，泄漏即断言失败。

> 注：用当前版本的 `daemon-lock.test.js` 复现不出泄漏——三个 preflight 用例现在
> 都是"拒绝启动"。所以这部分是**预防性**的，不是在修一个当下可复现的 bug。

## 行为变化（不是零成本）

1. **tmux 模式的 daemon 启动时会多一次 `tmux list-sessions`**，两处 stale 判定各再
   一次。非 tmux 部署完全不受影响（`FIRE_TMUX_MODE_ACTIVE` 把关）。
2. **降级认领的任务终态精度下降**：没有 hand-off record 时只能报 KILLED，报不出
   "completed"。只影响升级前就已经在跑的 Fire，一次性。
3. **多了一个磁盘目录** `$CONDUCTOR_HOME/daemon/fire-sessions/`。

## 下次如何避免

1. **"进程外仍可存活"的执行载体（tmux / launchd / systemd），判 stale 前必须查真实
   载体，而且要认领、不能只跳过。** 跳过 = 把误杀换成卡死，不是修复。
2. **成对的机制要成对地测。** "关闭时保留"和"启动时清算"分别都合理，凑在一起才是
   bug；只测其中一半永远发现不了。
3. **换掉一个"存活判定"的载体时，把所有读旧载体的地方一起扫一遍。** 认领引入了
   "没有 `child` 但活着"的新 record 形态，代码里有**四处**闸门写的是 `record.child`
   （restart / refresh / create / stop）。自审只找到三处，第四处是评审找到的——
   说明"逐个想场景"不可靠，应该直接 grep 字段名穷举。
4. **"探测失败"必须和"探测到没有"分开表示。** 任何返回空集合的探测函数都要带
   conclusive 标志，否则调用方迟早会拿"问不到"当"没有"用。这个文件里
   `probeTmuxSession` 早就这么做了，新代码没沿用。
5. **一个 bug 有两条触发路径时，两条都要写测试。** 本次 E2E 才发现"只修
   `reconcileAssignedTasks` 不够"——启动路径 `recoverStaleTasks()` 才是主场景，
   而且它连宽限期都没有。`cli/test/daemon-tmux-adoption.test.js` 现在把三个场景
   （会话存活 / 无会话 / 孤儿会话）× 两条路径全固化了，并且用变异测试确认过：
   把任一条路径改回旧行为，测试会红。
6. **事故文档里的"建议项"不进实现 = 没修。** 这条建议在 0723、0731 各记过一次，
   两次都没进代码，于是 0831 原样复发第三次。文档不是修复。
7. **任何 spawn 真实 daemon/fire 二进制的测试，白名单式构造 env。** 沙箱变量之间有
   优先级，只覆盖一个不构成隔离。

## 未做（需单独立项）

- **后端对同名 `daemonName` 重复上线仍是静默顶号**。认领机制消掉了"顶号 → 批量误杀"
  这个放大器，但顶号本身还在：两个同名 daemon 依然会互相顶掉 WS，形成秒级乒乓。
  应当拒绝或告警。
- `recoverStaleTasks()` 仍然没有宽限期。评估过：加 60s 会让"启动后 60s 内创建的真死
  任务"永远没人再清算（这个函数一辈子只跑一次，reconcile 只在重连时跑），
  下游风险大于收益。改用 `pendingTaskStarts` 精确挡住 spawn-in-flight 的竞态。
- 没有引入 owner lease / epoch fencing（archived plan 里的设计，现状仍无，
  见 `claw/architecture/task-fire-daemon.md` §2.3 / §13.4）。
- **同一 task 出现两个 tmux 会话的竞态只做了收敛，没有根治。** 后端在认领窗口内
  重投 `create_task`/`restart_task` 时，可能在同一 worktree 里起第二个 Fire。现在的
  处理是：认领时丢弃"非当前跟踪会话"的那份记录并**大声告警**，认领候选优先选有记录的
  会话，使下次重启的选择变确定。但不会自动杀掉多余会话（无法安全判断哪个该死），
  需要人工介入。根治要靠上面那条 fencing。
