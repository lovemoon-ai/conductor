# stable: tmux 会话内 fire 死亡不上报，任务卡 running 后被对账洗成「用户停止」(2026-07-23)

立档见 `claw/issues/stable_tmux_fire_death_unreported_20260723.md`（本文是该 issue 的修复记录）。

## 症状

tmux 模式下，fire 在会话里非正常死亡（backend 崩溃 / OOM / SIGKILL / 启动即退）后：

- 任务在 UI 上**长时间卡在 `running`**（要等 daemon 下次重连 + 60s 宽限期，常常数分钟）；
- 之后突然变 `killed`，`killedReason = user_stopped`，**但用户从没点过停止**；
- `task_status_events` 里没有任何能解释死因的 summary；
- 唯一有真相的地方是 worktree 里的 `conductor.log`。

## 根本原因

tmux 模式下 daemon 的子进程**不是 fire**，而是短命的 `tmux new-session` 客户端：

```
daemon
 └─ spawn("tmux", ["new-session","-d", …])   ← daemon 的 child，建完会话即退出(0)
       └─ tmux 服务器: bash -c "node conductor.js … 2>&1 | tee -a <logPath>"
                            └─ fire 进程      ← 真正干活的，与 daemon 完全脱钩
```

客户端退 0 后 exit handler 早返回（`cli/src/daemon.js` create 路径与 restart/fork 路径各一处）。
这个早返回本身是**正确的**——退 0 只意味着"会话建好了，fire 正在跑"，此时上报终态会把刚
启动的任务直接判死。问题在于**之后再也没有第二次观察机会**。

于是死亡沿着兜底链路一路被洗白：

1. fire 自报终态——但 SIGKILL / 启动即崩时它根本来不及自报；
2. `reapDeadTmuxSessionsOnce()` 探测到会话消失后，**只删本地 `activeTaskProcesses` 条目、
   不发任何 `task_status_update`**——只抹平了 daemon 自己的账本，后端仍以为任务在跑；
3. 第 2 步恰好让该任务**符合 reconcile 的收割条件**（后端 running、本地无记录），
   对账 `PATCH {status:"killed"}` 被 task PATCH 路由改写成先进 `killing`
   （`reason:"stopped_from_app"`），随后 `killing → killed` 在
   `web/src/lib/realtime/agent-upstream.ts` 被判定为 `killedReason = "user_stopped"`。

**一次进程异常，最终在 DB 里留下的死因是"用户停止"。** 与
`stable_daemon_reconcile_split_brain_autokill_20260606` 是同一个误导性指纹机制。

## 为什么之前没顺手修（以及这次怎么绕过去的）

issue 里列了三个必须先解决的问题，逐条对应本次的解法：

| 顾虑 | 解法 |
|---|---|
| ① `tmux has-session` 只能告诉你"会话没了"，**区分不了正常跑完还是异常死亡**，无脑报 KILLED 会把成功任务改判为失败 | 不再从"消失"这个事实推断，而是**让 fire 自己把退出码写进日志**，reaper 按退出码分类 |
| ② fire 可能已自报 COMPLETED，reaper 再补一发 KILLED 会覆盖终态 | 上报前**先查后端该任务状态**，已是终态就闭嘴；并在 web 侧补一道 `completed → killed` 的硬闸门兜住 TOCTOU |
| ③ 缺"谁先报谁赢"的规则与幂等语义 | 规则＝**fire 先报者赢**（reaper 只在后端仍非终态时补报）；幂等＝上报带 `status_event_id` |

## 修复

### 1. 让 fire 在 tmux 会话里自己记录退出码（`cli/src/daemon.js` `spawnFireProcess`）

会话内命令由

```bash
exec node conductor.js … 2>&1 | tee -a '<log>'
```

改为

```bash
node conductor.js … 2>&1 | tee -a '<log>'
__conductor_fire_code=${PIPESTATUS[0]}
printf '\n[conductor-fire-exit:<每次启动随机 nonce>] code=%s\n' "$__conductor_fire_code" >> '<log>'
exit $__conductor_fire_code
```

要点：

- **必须用 `${PIPESTATUS[0]}`**：管道里 `$?` 是 `tee` 的退出码，永远是 0。
- **必须去掉 `exec`**：包裹的 bash 要活得比 fire 久才能写下标记。
  （注意：调用处原本还套了一层 `exec`，两层叠加会变成 `exec exec …`，bash 直接报
  `exec: exec: not found` 退 127——fire 根本不会启动，而 tmux 客户端仍退 0，任务静默卡死。
  已改为每个分支自带 exec 语义、调用处不再包裹，并加了断言守住。）
- **标记必须带每次启动的随机 nonce，且锚定行首**。日志是 fire stdout 的逐字副本，
  所以**被观测者自己就能伪造标记**：只要 fire 打印过 `[conductor-fire-exit] code=0`
  （读自己的 conductor.log、或者正在改 daemon.js——本仓库自举时几乎必然发生），
  之后再被 SIGKILL，reaper 就会读到这条伪造标记，把**被杀的任务报成 COMPLETED**。
  nonce 让被观测者无法伪造，同时也天然使"上一轮的标记"不可能被误认。
- **标记缺失本身也是信号，但要先确认"本来能写"**：被 SIGKILL / OOM kill / tmux 服务器崩溃
  时 bash 来不及写标记，reaper 据此判定"死得很硬"。**但 `tee` 写不了日志时不会让 fire 失败**
  ——它只报错然后继续把 stdin 转给 stdout，fire 正常跑完、tmux 客户端照样退 0。
  此时既没有日志也没有标记，如果直接按"无标记=死得很硬"处理，就会把跑成功的任务
  报成 KILLED 并编造一个 OOM 死因。因此：**日志文件不存在 → 闭嘴**
  （`tee -a` 一打开就会创建文件，所以"文件不存在"＝当初就没法写；
  "文件存在但空"＝fire 真的没来得及输出，这两者可以区分）。
- 退出码判定沿用既有约定：`0` → COMPLETED，`130/143` → 终止，其余非零 → 崩溃。
  （被信号杀死的 node 会由 bash 记成 `128+N`，如 SIGKILL → `137`。）

### 2. reaper 探测到会话消失时上报终态（`reapDeadTmuxSessionsOnce`）

- 读 `logPath` 尾巴 → `parseFireExitCode()` 取**最后一个**标记 → 判定 COMPLETED / KILLED；
- 上报前 `GET /api/tasks/:id`，后端已是 `completed`/`killed` 就**不上报**；
- KILLED 时把脱敏后的日志尾巴放进 summary，并打一行 `[tmux-reap]` 诊断
  （含 task / tmux / exit / lifetime_ms / log / backend_status / output_tail）；
- 带 `status_event_id` 幂等键，保证 summary 落库且重投不会变成第二条事件。

**标记要"搜"而不是"读末尾"**：任务日志**不是私有的**——branch/fork 刻意共用 worktree
（因而共用一个 `conductor.log`），没有 worktree 配置的任务还会回落到项目目录，
于是**同项目所有任务都往同一个文件里追加**。只要邻居 fire 在"我们退出"到"下一轮 reaper"
之间打印几 KB，就会把我们的标记挤出固定大小的尾巴窗口 → 判成"无标记" → 把跑成功的任务
报成 KILLED，**还把邻居的输出当成死因引用**。所以改为按 nonce **从文件尾向前分块搜索**
（上限 8MB、64KB 步长、带重叠避免跨块截断），尾巴仍只用于人类可读的 summary。

新增两个防线：

- **`logStartOffset` 水位线**：日志文件以 `flags:"a"` 打开、原地重启会复用同一个文件，
  不设水位线就会把**上一轮**的退出码标记当成本轮的。spawn 前采样文件大小，之后所有
  尾巴读取都不越过这条线。（同时也修正了原有 `outputCapture.tail()` 的同类问题。）
- **`TMUX_REAP_GRACE_MS`（默认 15s）启动宽限期**：记录写入 `activeTaskProcesses` 与 tmux
  服务器完成会话注册之间有一个窗口，此间 `has-session` 会对健康任务答 false。
  这个窗口在"reaper 只清账本"时无害，代码注释里也写着"理论上存在、故意不管"；
  **一旦 reaper 开始上报终态，它就会杀掉刚起来的正常任务**，所以必须补。

### 3. 允许「监护 daemon」替已死的 fire 上报终态（`web/src/lib/realtime/agent-upstream.ts`）

**这一条是本地 E2E 才发现的，缺了它整个修复完全无效。**

fire 启动后会用自己的 host 身份（`conductor-fire-unknown-host-<pid>`）连上来并**接管
`executionHost`**。所以健康 tmux 任务的 `getAssignedTaskHost()` 返回的一直是 **fire**，
不是 spawn 它的 daemon。等 fire 死了，唯一的目击者只剩 daemon，而 `ensureAgentOwnsTaskRecord`
的归属校验会把它顶回去：

```
[tmux-reap] fire died inside its session task=… exit=137 backend_status=running output_tail=…
Backend error: Task … is assigned to conductor-fire-unknown-host-49550, not debug
```

daemon 侧一切正确（读到标记、算出 137、带上日志尾巴），**后端把这份报告丢掉了**，
任务继续挂在 `running` —— 回到原点。

修法：允许 `task.agentHost` 指定的那个 daemon，为**已经断开的 fire host** 发布终态。
刻意收窄成四条前提，缺一不可：
- fire 仍在线时不适用（活着的 fire 自己报）；
- 非终态不适用（不能借此抢走/复活一个在跑的任务）；
- 只有 `task.agentHost` 那个 daemon 可以，别的 daemon 不行；
- 且**不重绑 executionHost**——我们是在记录一次死亡，不是接管这份工作。

安全性：`agentHost` 是客户端自报的 `x-conductor-host` 头，但它在 `authenticateToken`
之后、且 `hasAgentHost()` 与任务查询都按 `userId` 收敛，**不存在跨租户风险**；
同账号内，客户端本来就可以直接自称 assigned host 走正常分支，所以这条豁免
**没有放大任何既有权限**。

顺带修好的：**用户主动 stop 一个 tmux 任务**时，daemon 在 `kill-session` 后补发的
KILLED 过去同样会因归属校验被拒（fire 持有 `executionHost`）。现在能落库了，且因为
UI 的 stop 先把状态 PATCH 成 `killing`，`killing → killed` 仍判为 `user_stopped`，
不会被误标成 `fire_exit`。（`stopActiveTaskProcess` 会立刻删掉本地记录，
所以 reaper 不会再重复上报同一次停止。）

### 4. web 侧禁止 `completed → killed`（`web/src/lib/realtime/agent-upstream.ts`）

`commitTaskStatusUpdate` 原本**只有 `killing` 一道转移闸门**，没有任何终态保护：已经
`completed` 的任务收到一发 KILLED 会被改写成 `killed` + `killedReason:"fire_exit"`。

一个任务的结束有**两个上报方**：fire 自报（知情）、daemon 观察（只能看到"某个东西不见了"，
天然不知情，且必然后到）。让后到且不知情的一方覆盖前者，就是把用户亲眼看着成功的任务
在几分钟后改判成失败。daemon 侧的预检查是 TOCTOU 的，**这道闸门才是真正兜底的**。

注意闸门只挡 `completed → killed`：用户停止走的是 `killing → killed`，不受影响（有回归测试）。
顺带修掉了独立立档的 `stable_m1_codex_task_complete_then_stale_killed_20260311`。

## 回归测试

`cli/test/daemon.test.js`：

- `makes a tmux-hosted fire record its own exit code, readable by real bash` ——
  **取 daemon 真正生成的那条命令，塞进真 bash 执行**，断言退出码透传（42 而不是 tee 的 0）、
  输出进了日志、标记可被解析。字符串匹配测不出引号 / `PIPESTATUS` 写错，而写错的后果是
  线上每个 fire 都退化成"无标记 → 一律判死"。
- `reports KILLED with the real cause when a fire dies inside its tmux session`
- `reports COMPLETED, not KILLED, when a fire finished before its tmux session ended`（顾虑①）
- `reports KILLED when a tmux session vanishes without an exit marker`（SIGKILL/OOM）
- `stays silent when the fire already published its own terminal status`（顾虑②）
- `exempts freshly spawned tmux tasks from the reaper`（启动竞态）

`web/src/lib/realtime/agent-upstream.test.ts`：
`does not let a late killed update overwrite a completed task` +
`still lets a user-requested stop of a completed task through killing`（确认闸门没误伤用户停止）。

前四条已验证在**去掉修复后会失败**（不是空跑的测试）。

同时修正了既有测试夹具 `runForkDiagnosticsCase`：原来的 `statSync` 让日志文件在 spawn
**之前**就有完整内容，与现实相反；加了水位线后这种夹具会读到空尾巴。改为 spawn 后才"写入"。

## 已知残留（未修）

- **daemon 重启后，上一代 daemon 起的 tmux 会话无人认领**。`activeTaskProcesses` 是纯内存
  账本，daemon 重启即丢；此后那些会话里的 fire 若死亡，仍然只能落到 reconcile 兜底，
  死因依旧会写成 `user_stopped`。要覆盖需要在重连时按 `tmux list-sessions` 反向重建记录
  （`conductor-fire-<taskId>-<suffix>` 的会话名里带 taskId，信息是够的），属于另一块工作。
- **本轮只覆盖 tmux 模式**。非 tmux bridge 模式仍会抑制终态上报
  （`shouldDaemonReportFireChildTerminalStatus`），沿用
  `stable_branch_fork_spawn_blackbox_20260723` 里登记的那条残留。
- **tmux 配了 `remain-on-exit on` 时本修复不生效**：pane 在命令退出后保留，会话不消失，
  `has-session` 恒为真，reaper 永远不会触发。默认配置不开该选项，但用户自己的 `~/.tmux.conf`
  可能开。
- **探测不确定时刻意不动**：`tmux` 缺失 / 服务器卡死 / 探测超时都归为"不确定"，此时
  reaper 既不清账本也不上报（旧行为是一律当成"死了"）。代价是 tmux 长期损坏时内存账本会
  滞留，好处是不会因为一次抖动把满屏活着的任务判死。`reclaim_task` 与 restart 前置检查
  两处同样改为"不确定即不动"——前者误判会把活着的 fire 报成 stale 导致**同一 worktree 里
  起两个 fire**，后者误判会让防重复 spawn 的闸门失效。
- **共用日志时 summary 仍可能引用邻居输出**：退出码判定已用 nonce 精确定位，不受影响；
  但用于 summary 的"尾巴"在共用文件里无法区分作者。属已知的表述噪音，不影响死因判定。
- **`suppressedExitStatusReports` 在 tmux 模式下永不清理**：tmux 客户端的 exit handler 走
  早返回分支，不会消费该标记。reaper 因此**刻意不读它**（读了反而会被过期标记误导，
  把后来一次无关的死亡吞掉），代码里有注释说明。真正清理它属于独立的小修。

## 如何避免

- **「进程退出」不等于「任务结束」**。任何把工作交给中间层（tmux / 容器 / 调度器）的设计，
  都必须显式回答"真正的工作进程死了，谁来通知"，而不能依赖对直接子进程的 exit 观察。
- **清理本地账本的逻辑，必须同时回答要不要通知远端**。`reapDeadTmuxSessionsOnce` 只清账本
  不上报，反而让任务恰好落入对账的收割条件，把"进程异常"洗成了"用户停止"——
  只清一半比不清更危险。
- **对账（reconcile）是最后的安全网，不该承担"解释死因"的职责**。一旦某条路径常态性地
  依赖对账兜底，死因就必然丢失。
- **观测不到退出码，就想办法让被观测方自己写下来**。与其在外面猜，不如让进程留下自证。
  "标记缺失"也要设计成一个有意义的信号。
- **但被观测者能写的"证据"就不是证据**。日志是 fire stdout 的逐字副本，固定字面量的标记
  等于让被观测进程自己签发死亡证明——它只要打印过那行字就能伪造。凡是"从进程自己产生的
  数据里读取控制信息"，都必须带一个**观测方生成、被观测方无从得知的 nonce**。
- **区分"没有证据"和"证据表明没有"**。`tee` 写不了日志 → 没有标记；fire 被 SIGKILL → 也没有
  标记。前者必须闭嘴，后者才能判死。分不开就会凭空编造死因——**编造出来的死因比没有死因
  更有害**，因为它看起来是可信的（这正是本 issue 里 `user_stopped` 之所以难查的原因，
  修复时不能重演同一个错误）。
- **把某个竞态注释成"理论上存在、故意不管"时，要连同它成立的前提一起写下来**。这里的前提是
  "reaper 只做本地清理"；前提一变（开始上报终态），同一个窗口就从无害变成会误杀。
  改动碰到这类注释时，先验证前提是否还成立。
- **单元测试 mock 掉的那一层，正是最可能出错的一层**。本次 daemon 侧逻辑有 10 个用例、
  真 bash / 真 tmux 都验过，唯独"后端会接受这份上报"是被 mock 假设成立的——而它恰恰
  不成立（fire 接管了 `executionHost`，daemon 被判定为无权上报）。**修复上线即失效，
  而所有测试都是绿的。** 凡是"A 发消息、B 接受"的链路，至少要有一次真实的端到端验证，
  或者让单元测试覆盖真实的鉴权/归属分支，而不是 mock 掉它。
- **本地 E2E 要在"改完代码之后、提交之前"跑**，而且要确认**改动真的加载进去了**：
  Next.js 的 HMR 不会重载自定义 `server.ts` 里的 WS 网关，第一次复测因此跑的还是旧代码，
  差点得出"修好了"的错误结论（表现是任务确实变成了 `killed`，但 `killedReason` 是
  `daemon_disconnected`——是热重载踢掉连接造成的，不是修复生效）。**看结论要看死因，
  不能只看状态。**
- **多个上报方写同一个终态时，必须先定"谁赢"**。知情的一方（fire 自报）优先，
  不知情且后到的一方（外部观察）只在前者缺席时补位；且要在**服务端**有硬闸门，
  因为客户端的"先查再写"永远是 TOCTOU。
