# stable: daemon 继承 root 的 TMUX 环境变量导致 l20-yy 上所有 restart / 新 round 失败（2026-09-18）

## 结论

涉及任务：`5b23df19-8e37-4b81-bccb-c1760016427f`「音频翻译转录服务」
（project `6c83cfa0`，daemon `l20-yy`，backend `codex`，persistent task）。

任务无法 restart，开新 round 也会在约 2 秒内被判定 `killed`，summary 为：

```text
exited with code 1: error connecting to /tmp/tmux-0/default (Permission denied)
```

根因在 daemon 的**运行环境**，与任务本身无关：

- l20-yy 的 daemon（pid 1674048）以 `yy`（uid 1000）身份运行，但它的 env
  里带着 `TMUX=/tmp/tmux-0/default,1600,1`、`TMUX_PANE=%1`，也就是 root 的
  tmux server（`tmux new -s ws`，pid 1600）里 pane `%1` 的上下文。
- daemon 开启了 `fire_tmux_mode`。每次 spawn Fire 都会执行
  `tmux new-session -d ...`，使用的是 daemon 自己的 env。当没有
  `-L`/`-S` 时，tmux 会**优先使用 `$TMUX` 里的 socket**，而不是本 uid
  默认的 `/tmp/tmux-1000/default`。于是它去连 root 的
  `/tmp/tmux-0/default`（目录权限 `drwx------ root`），得到 EACCES，client
  exit 1，Fire 根本没有启动。
- 代码里没有任何地方剥掉继承来的 `TMUX`/`TMUX_PANE`。

诊断类型：`live`。层级：daemon 宿主环境 / tmux spawn 执行层。
不是 outbox、websocket、host 绑定问题，也不是 daemon 离线（daemon 在线且
connected）。

## 线上证据

`conductor diagnose 5b23df19-... --json`：`status=killed`，
`agent_host=execution_host=bound=l20-yy`，bound/assigned 都是 connected，
`latest_status_summary` 就是上面那条 tmux 报错。

`conductor remote exec -t l20-yy`（只读）：

```text
id: uid=1000(yy)
TMUX=/tmp/tmux-0/default,1600,1 TMUX_PANE=%1
/proc/1674048/environ: TMUX=/tmp/tmux-0/default,1600,1, TMUX_PANE=%1, USER=yy
drwx------ root root /tmp/tmux-0     drwx------ yy yy /tmp/tmux-1000
tmux ls                        -> error connecting to /tmp/tmux-0/default (Permission denied)
env -u TMUX -u TMUX_PANE tmux ls -> 0: 1 windows (created Tue Sep  8 07:06:08 2026)
root 1600  tmux new -s ws  (Sep 8)
yy   1674048 ppid=1 started 2026-09-18 07:20:36 UTC  conductor-daemon.js --force
```

daemon 日志 `~/.conductor/logs/2026-09-18T15-20-36-565.log`（时间为 Asia/Shanghai）：

```text
15:20:36 Fire tmux mode enabled
15:22:08 tmux(...1750b098...) stderr: error connecting to /tmp/tmux-0/default (Permission denied)   # restart 1750b098
15:22:37 tmux(...e30b48e7...) stderr: error connecting to /tmp/tmux-0/default (Permission denied)   # restart e30b48e7
20:24:02 Restarting task 5b23df19 (resume_inplace -> codex) ... Permission denied, lifetime_ms=6
20:24:50 Creating task 5b23df19 (Round 2) ... Permission denied, lifetime_ms=1
```

## 时间线（UTC）

1. 2026-09-17 23:25：本任务 fork 到 l20-yy，round 1 在 tmux 模式下正常运行
   （log 里有 `[conductor-fire-exit:beec9d620ffc] code=0`，说明当时 tmux 正常）。
2. 09-18 05:25：daemon 自动升级 0.12.0 → 0.13.1 失败（根分区 ENOSPC，随后
   node-pty rebuild 失败），CLI 包被删除（`daemon-update.log`）。
3. 07:02–07:09：手动重装。`~/.conductor` 改为软链到
   `/vepfs-pykaxon/yueyu/ws/.conductor`，`node` 和 `bin` 重建。
4. 07:20:36：在 root 的 tmux 会话 `ws` 的 pane `%1` 中 `su` 到 yy（没有
   `-`，环境变量被保留），执行 `conductor daemon --force`。新 daemon 从此
   带着 root 的 TMUX。
5. 此后 l20-yy 上**每一次** tmux spawn 都失败：07:22 的 `1750b098`
   「blender gpt6」、`e30b48e7`「blender & real2sim [codex]」，以及 12:24 本任务的
   restart 和 Round 2。三个任务目前都是 `killed`。

## 影响面

- l20-yy 上所有 create_task / restart_task / persistent round 都会失败，
  不只是本任务。
- 在同一个错误 env 下，`tmux has-session` / `list-sessions` 同样 exit 1。
  代码把它当作「tmux 明确回答：session 不存在」（conclusive），因此 reaper
  和启动时的 adoption 会误判存活的 Fire；`kill-session` 也会静默失败。

## 第二个问题：`command too long`

修掉 TMUX 之后开 Round 3，任务立刻又被 killed：`exited with code 1: command too long`。
这是另一个独立的 bug：tmux client 的整个 argv 不能超过 16KB（imsg 上限）。
- l20-yy 上 daemon 的 env 有 85 个变量，全部以 `-e` 传入，约 7.6KB（`NVIDIA_REQUIRE_CUDA`
  2.2KB，`LS_COLORS` 1.5KB）。
- persistent round 的 prompt 里内联了上一轮总结（7.5KB）。

两者加起来超过了限制。详见
`claw/lessons/stable_tmux-command-too-long-long-prompt-20260918.md`。

## 处置（2026-09-18，已执行）

### 线上恢复

1. 通过 `conductor remote exec -t l20-yy`，执行
   `env -u TMUX -u TMUX_PANE ~/.conductor/bin/conductor daemon --force --nohup`。
   重启前确认过没有在跑的 Fire 或 PTY。重启后新 daemon 的 env 里没有 `TMUX`，
   `tmux ls` 能正常连上 yy 自己的 tmux server。
2. Round 3 因为 `command too long` 失败。由于代码修复尚未发布，再次用同样的方式
   重启 daemon，并额外去掉 `LS_COLORS` 和 `NVIDIA_REQUIRE_CUDA`，env flags 从
   7.6KB 降到 3.9KB。
3. 调 `POST /api/tasks/5b23df19-.../rounds`（content 与 Round 2 相同，
   `agent_host=l20-yy`，`expected_round=3`）开 Round 4。结果：`running`，
   `codex session started: 01a0b49c-...`，AI 已回复（请用户发新一期的链接）。

已知残留：`latest_status_summary` 仍显示上一次的 `command too long`（成功启动后
不会清掉，已有问题）。`1750b098`、`e30b48e7` 仍是 killed，需要用户自己 restart。

### 根因修复

1. `cli/src/daemon.js startDaemon`：在解析 tmux 模式之前
   `delete process.env.TMUX; delete process.env.TMUX_PANE;`。daemon 不在任何
   tmux pane 里，它的 tmux client、探活、kill、PTY shell、remote exec 都应该使用
   本 uid 的默认 socket。
2. `spawnFireProcess`：tmux argv 超过 12KB 时，把命令写进
   `<CONDUCTOR_HOME>/daemon/fire-sessions/<session>.sh`（0600，首行自删），
   改为执行 `bash <script>`。tmux 启动失败时由 daemon 删除脚本。

测试：两个修复各有一个回归测试，去掉修复时都会失败、加上后通过。`cli` 全量
测试通过。另外用真实的 tmux 3.5a 验证过：`bash -c` 会报 `command too long`，
脚本方式能正常运行，bash 收到完整的 30000 字节，脚本已自删。

要等 release 并且 l20-yy 的 daemon 升级重启之后，代码修复才会生效。在那之前，
l20-yy 靠上面精简过 env 的 daemon 撑着：总结再变长的话可能还会超限。
