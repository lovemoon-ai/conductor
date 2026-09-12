# stable: 无 tmux 的 PATH 下重启 daemon，误杀它看不见的 tmux Fire（2026-09-12）

前置阅读：`claw/lessons/stable_daemon-adopt-tmux-fires-on-startup-20260901.md`
（认领机制本身）与 `claw/lessons/stable_test-spawned-rogue-prod-daemon-mass-kill-20260831.md`
（第三次复发的事故复盘）。

本文记的是 8ad51f3 认领修复**留下的最后一个洞**：同一类"我看不见"被从第三扇门
放了进来。QA 2026-09-01 round 2 报出，属 pre-existing（v0.11.0 同样复现），
不是 8ad51f3 引入的回归。

## 症状

`fire_tmux_mode: true` 时，daemon 重启本应把 detached Fire 交接给后继进程。
但如果后继 daemon 启动时 `tmux` 不在 PATH 上：

```text
[conductor-daemon] fire_tmux_mode is enabled but `tmux` is not available on PATH; falling back to direct spawn. ...
[conductor-daemon] Recovered 1/1 stale task(s) to killed
```

任务变 `killed`、Fire 进程被杀、tmux session 消失——正是交接机制要防的结果。
100% 复现，约 10s 内发生。

## 根因

`8ad51f3` 立的规则是**"liveness 答案不确定就绝不授权 kill"**，并为两种"看不见"
装了闸门：

| 看不见的方式 | 闸门 | 判据 |
| --- | --- | --- |
| `tmux list-sessions` 问不出来（server 卡死 / 超时） | `listAllTmuxSessions().conclusive` | 列表不可信就整轮 skip |
| 启动时 `tmux -V` 抽风，`FIRE_TMUX_MODE_ACTIVE` 误判为 false | `tmuxFiresMayExistUnseen()` | **重新探测** tmux，探到就 skip |
| **tmux 二进制根本不在 PATH 上** | 无 | — |

第三行就是这次的洞。关键在于 `tmuxFiresMayExistUnseen()` 的实现：

```js
return FIRE_TMUX_MODE_ENABLED && !FIRE_TMUX_MODE_ACTIVE && isTmuxAvailable();
```

它靠 `isTmuxAvailable()` 重新探测来判断"其实 tmux 是好的、只是启动快照错了"。
**tmux 真的不存在时，这个重新探测同样失败，闸门自己把自己判成不成立**，于是：

- `FIRE_TMUX_MODE_ACTIVE = false` → `adoptOrphanedTmuxFires()` 直接 return 0，不认领；
- `tmuxFiresMayExistUnseen()` = false → 不 skip；
- `tmuxSessions = null` → `adoptLiveTmuxFireForTask()` 因 `!FIRE_TMUX_MODE_ACTIVE` 一律返回 false；
- 全部 stale 任务被 PATCH 成 `killed`。

**写闸门时把"探测失败"默认当成了"没有东西要保护"，而它恰恰是最该保护的那一档。**

### 为什么现实中会踩到

触发条件只是"用最小 PATH 重启 daemon"：launchd / systemd unit、cron、任何非登录
shell 都是这个默认。本机 tmux 装在 `/opt/homebrew/bin`，这些上下文routinely 不带。
`brew upgrade tmux` 的窗口期同样命中。

## 修复

### 为什么不是"ENABLED && !ACTIVE 就整轮 skip"

最直观的补丁是把闸门放宽成 `FIRE_TMUX_MODE_ENABLED && !FIRE_TMUX_MODE_ACTIVE`
（去掉重新探测）。但这会在另一头造成危害：**一台配了 `fire_tmux_mode: true`
却始终没装 tmux 的机器**，Fire 是直接 spawn 的，`shutdownDaemon` 会给它们
SIGTERM，它们确实随 daemon 一起死——stale sweep 是唯一会上报其死亡的东西。
整轮 skip 会让这些任务永远卡在 `running` 且无人认领。

这正是 20260901 那份 lesson 已经写过的取舍：**"跳过 kill" 换来的 "卡 running
没有 watcher" 比误杀更糟。** 不能为了堵一个洞再开一个。

### 实际做法：用磁盘上的交接记录界定无知的范围

`~/.conductor/daemon/fire-sessions/*.json` 里的 hand-off record 正是"上一个
daemon 确实为任务 X 留了一个 tmux Fire"的自证。tmux 不可用时，它就是仅存的证据：

```js
function taskIdsWithUnverifiableTmuxFire() {
  if (!FIRE_TMUX_MODE_ENABLED || FIRE_TMUX_MODE_ACTIVE) return new Set();
  return listFireSessionTaskIds(FIRE_SESSION_REGISTRY_DIR);
}
```

`recoverStaleTasks()` 与 `reconcileAssignedTasks()` 都按这个集合跳过、并大声记日志。

判据是精确的——任务 X 没有记录，只可能是下面三种，三种都该照常清算：

- 它从来没跑过 tmux Fire（直接 spawn）；
- 记录在 Fire 正常退出时被 `forgetFireSessionRecord` 删了；
- 记录被 `pruneFireSessionRecords` 剪掉了——而剪枝只在 listing **conclusive**
  时才跑，也就是当时确认过 session 已不存在。

同理，这个状态下**没有任何东西会剪枝**（剪枝需要 conclusive listing，而它需要
`FIRE_TMUX_MODE_ACTIVE`），所以记录会原样留到下一次带 tmux 的启动，届时
`adoptOrphanedTmuxFires()` 正常认领或回收。滞留有界，不是永久卡死。

## 回归测试

`cli/test/daemon-tmux-adoption.test.js` 新增 `tmuxBinaryMissing` 场景（`tmux -V`
的 spawnSync 一律返回 ENOENT），两条用例互为配重：

- `kills nothing for a task whose hand-off record it cannot verify without tmux`
  —— 洞本身；修复前必挂（任务被 kill），修复后通过。
- `still kills a task with no hand-off record when tmux is missing`
  —— 配重；防止后人把修复简化成整轮 skip 而没人发现卡 running 的代价。

`cd cli && node --test test/daemon-tmux-adoption.test.js` → 22/22。

## 下次怎么不再犯

1. **凡是形如 `A && !B && probe()` 的"救命闸门"，必须单独问一句：probe 本身失败时
   会怎样？** 这里 probe 失败恰恰是最危险的一档，却让闸门静默失效。救命闸门的默认
   方向应当是 fail-safe（不确定就不破坏），而不是 fail-open。
2. **"我看不见 X" 有多少种发生方式，就要枚举多少扇门。** 这个 bug 的三扇门是：
   listing 问不出来、探测快照过时、二进制不存在。堵了两扇就收工，等于没堵。
3. **不要用"整轮 skip"堵洞。** 每次放宽 kill 条件都要反问：被放过的任务由谁上报终态？
   有 watcher 吗？没有的话滞留是否有界？用磁盘证据把无知的范围**界定**出来，
   比笼统地"都别杀了"安全。
4. **每个闸门配一条配重用例。** 只测"不该杀的没杀"，下一个人就能用整轮 skip 通过测试。
