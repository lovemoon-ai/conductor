# stable: tmux 会话内 fire 死亡不上报，任务卡 running 后被对账误判为「用户停止」（2026-07-23）

状态：**已修复**（2026-07-23，提交 `61b8b90`）。修复记录见
`claw/lessons/stable_tmux_fire_death_unreported_20260723.md`。

下文「为什么没有顺手修」列出的三个顾虑，逐条对应的解法：
① **不再从"会话消失"推断**：让包裹 shell 把 fire 的退出码写进日志（`${PIPESTATUS[0]}`），
   按退出码分类。标记带**每次启动的随机 nonce** 且锚定行首——日志是 fire stdout 的逐字
   副本，固定字面量会被**被观测者自己伪造**；标记还需**全文件搜索**而非只读末尾，
   因为 branch/fork 共用同一个 `conductor.log`，邻居输出会把它挤出尾巴窗口。
② **不覆盖已有终态**：上报前先查后端状态；web 侧再补一道**对称**闸门——已落一个终态就
   不迁移到另一个终态（`killed↔completed` 双向），仅保留 `daemon_disconnected`
   这一"防御性判死"可被撤销。
③ **谁先报谁赢**：知情的 fire 自报优先，daemon 只在其缺席时补位；上报带
   `status_event_id` 幂等键。

**另有一条三个顾虑里没预见、且缺了它整个修复完全无效的**（本地 E2E 才暴露）：
fire 会用自己的 host 身份接管 `executionHost`，于是健康任务的归属主机一直是 fire 而非
daemon；fire 死后唯一的目击者 daemon 反而被归属校验拒绝，任务照样卡 `running`。
现允许**监护它的那个 daemon** 为已断开的 fire host 发布终态（仅终态、仅监护者、
需断开超过重连抖动窗口、且不重绑 `executionHost`）。

层级：daemon 进程观测层（tmux 模式）。不涉及路由 / WS / schema。

## 结论先行

tmux 模式下，daemon 的子进程是**短命的 `tmux new-session` 客户端**，不是 fire 本身。
客户端建好会话后即以 0 退出，exit handler 因此**早返回**。此后 fire 在 tmux 会话里
**无论怎么死，daemon 都观察不到**，也就永远不会上报终态。

后果不是「少了一条日志」，而是：

> 任务在 UI 上**长时间卡在 `running`** → 最终被 reconcile 对账收割 →
> `killedReason` 落成 **`user_stopped`**，看起来像用户点了停止，**没有任何真实死因**。

即这条路径退化回一个黑盒 —— 正是 `stable_branch_fork_spawn_blackbox_20260723`
那一轮补丁想要消灭的东西，只是它没能覆盖到这里。

## 进程结构（问题的根源）

```
daemon
 └─ spawn("tmux", ["new-session","-d", …])      ← daemon 的 child = tmux 客户端
       │  唯一职责：请 tmux 服务器建会话，建完就退出(0)
       └─ tmux 服务器: bash -c "node conductor.js … 2>&1 | tee -a <logPath>"
                            └─ fire 进程         ← 真正干活的，与 daemon 完全脱钩
```

`cli/src/daemon.js:1007` `spawnFireProcess()`，tmux 分支在 `:1026` 通过
`… 2>&1 | tee -a <logPath>` 把 fire 的输出直接写进日志文件 —— **不经过 daemon 的管道**。

## 早返回本身是正确的

`cli/src/daemon.js:5631`（create_task 路径）与 `:6266`（restart/fork 路径）：

```js
if (active?.tmuxMode && !signal && code === 0) {
  log(`Fire launched in detached tmux session: …`);
  return;            // ← 不上报任何终态
}
```

这个早返回**必须存在**：客户端退出 0 只意味着「会话建好了，fire 正在跑」。
若此刻上报 COMPLETED，会把刚启动的任务直接判死。**所以问题不在这一行，
而在于 daemon 之后再也没有第二次观察机会。**

## 三种情况的实际表现

| 情况 | daemon 能观察到什么 | 结果 |
|---|---|---|
| fire 启动成功 | 客户端退 0 → 早返回 | ✅ 正确 |
| tmux 拒绝建会话（会话重名、tmux 服务器异常…） | 客户端退**非 0** → 走上报分支 | ✅ 会报 KILLED，且已带 `[fork-spawn]` / `[create-spawn]` 诊断 |
| **fire 在会话内死亡**（backend 崩溃 / OOM / 启动即退 / 被 SIGKILL） | **无任何句柄**，客户端早已退出，不会再有 exit 事件 | ❌ **永不上报** |

## 兜底链路，以及它为什么"看起来像用户停止"

1. **fire 自报**（正常情况）：fire 有自己的 WebSocket，会自己上报终态。
   → 所以只有 fire **来不及自报就死了** 才真正漏（SIGKILL、段错误、启动阶段崩溃）。
2. **tmux 存活轮询** `reapDeadTmuxSessionsOnce()`（`cli/src/daemon.js:1172`，
   默认每 30s，`TMUX_LIVENESS_POLL_MS` 见 `:2264`，调度在 `:2463`）：
   探测到 `tmux has-session` 失败后，**只打一行日志 + 删除本地
   `activeTaskProcesses` 条目**（`:1185`），**不发送任何 `task_status_update`**。
   → 它只抹平了 daemon 自己的账本，后端依旧认为任务在跑。
3. **reconcile 对账**（`cli/src/daemon.js:3091`，宽限期 60s 见 `:3089`）：
   daemon 重连时扫描「后端 running / unknown，但本地账本没有」的任务，
   PATCH 成 `killed`。第 2 步刚好把本地条目删掉，于是该任务**正好符合被收割条件**。

而对账那条 `PATCH {status:"killed"}` 会被 task PATCH 路由改写成**先进 `killing`**
（`web/src/app/api/tasks/[taskId]/route.ts:506`，并带 `reason:"stopped_from_app"` 见 `:563`）；
随后 `killing → killed` 的转换在 `web/src/lib/realtime/agent-upstream.ts:527`
被判定为 **`killedReason = "user_stopped"`**。

**所以最终 DB 里留下的死因是「用户停止」，与真实原因（backend 崩溃）毫无关系。**
这与 `stable_daemon_reconcile_split_brain_autokill_20260606` 记录的误导性指纹是同一个机制。

## 用户可见症状（排查时的识别特征）

- 任务在 UI 上卡在 `running` 很久（需等 daemon 下次重连 + 60s 宽限期，可能数分钟起）；
- 之后突然变 `killed`，`killedReason = user_stopped`，但**用户并没有点停止**；
- `task_status_events` 里没有能解释死因的 summary；
- 但 **worktree 里的 `conductor.log` 有真实错误**（fire 的输出经 `tee` 写在那里）。
  ⇒ 排查时优先去看这个文件，而不是相信 `killedReason`。

## 为什么没有顺手修

修法方向很清楚：让 `reapDeadTmuxSessionsOnce()` 在探测到会话消失时主动上报终态，
并顺带读 `logPath` 尾巴给出真实原因（`createChildOutputCapture({ logPath })` 已具备
读取能力，见 `stable_branch_fork_spawn_blackbox_20260723`）。

但它是**行为变更而非纯观测**，有三个必须先解决的问题：

1. **会误杀成功的任务（最难的一条）**。`tmux has-session` 只能告诉你「会话没了」，
   **区分不了 fire 是正常跑完还是异常死亡**。无脑上报 KILLED 会把已成功的任务
   改判为失败。
2. **与 fire 自报竞争 / 覆盖**。fire 很可能已经上报过 COMPLETED，reaper 再补一发
   KILLED 就会把终态覆盖掉。
3. 需要明确「谁先报谁赢」的规则，以及重复上报时的幂等语义。

## 建议的修复方向（当时的设想；**已实施，但实际做法有出入**）

> 以下是立档当时的设想，保留以对照。实际落地时有两处关键偏差：
> 第 2 点的「读 `logPath` 尾巴取退出码」不够——退出码必须由**包裹 shell 主动写入**
> （fire 自己不会打印它），且标记要带 nonce、要全文件搜索，否则会被伪造或被邻居挤掉；
> 另外还需要一条这里完全没预见的**后端归属豁免**（见文首），否则上报会被直接拒绝。

reaper 探测到会话消失时：

1. 先判断该任务是否**仍需要终态** —— 本地记一个「fire 已自报终态」标志，
   或查询后端该任务是否仍为 `running`；
2. 若仍需要，读取 `logPath` 尾巴，**按其中的退出码判定 COMPLETED / KILLED**，
   而不是一律 KILLED；
3. 上报时带上 `output_tail` 作为 summary，并附 `status_event_id`
   （幂等键，避免与 fire 自报重复计入；参见同日提交 `cdeea27`）。

这样既补上漏报，又不会误杀成功任务，且死因自证。

## 如何避免（这一类问题的通用教训）

- **「进程退出」不等于「任务结束」**：任何把工作交给中间层（tmux / 容器 / 调度器）
  的设计，都必须显式回答「真正的工作进程死了，谁来通知」，而不能依赖对直接子进程的
  exit 观察。
- **清理本地账本的逻辑，必须同时考虑要不要通知远端**。`reapDeadTmuxSessionsOnce`
  只清账本不上报，反而让任务恰好落入对账的收割条件，把一次「进程异常」洗成了
  「用户停止」。
- **对账（reconcile）是最后的安全网，不该承担「解释死因」的职责**。一旦某条路径
  常态性地依赖对账兜底，死因就必然丢失。

## 相关

- `claw/lessons/stable_branch_fork_spawn_blackbox_20260723.md`（本问题在该文
  「已知残留」中登记；那轮补丁覆盖了 tmux 启动失败与 spawn 前失败，未覆盖本问题）
- `claw/lessons/stable_daemon_reconcile_split_brain_autokill_20260606.md`
  （`user_stopped` 误导性指纹的同源机制）
