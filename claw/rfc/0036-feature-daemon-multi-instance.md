# 0036 Conductor 多实例（profile）

## Status

Draft — 卡点盘点已完成，方案待定

## Owner

dang217

## Date

2026-08-30

## Summary

今天 Conductor 隐含假设「一台机器 = 一个全局身份」：一份 `~/.conductor`、一个
`~/ws/daemon.pid`、一个默认叫 `os.hostname()` 的 daemon、一套 `~/.codex` / `~/.claude` 凭据。
本 RFC 盘点把这个假设拆掉需要动的所有地方，并提出把散落的 N 根环境变量收敛成
一个一等公民的 **profile** 概念。

**核心结论**：零件基本都有了，缺的是「实例」这个概念把它们绑成整体。
- Conductor 自身状态：`CONDUCTOR_HOME` 机制可用且能传给子进程，但需要同时设对
  **6 个互不推导的环境变量**，漏一个就是破坏性后果。
- AI CLI 凭据：`config.yaml` 的 `envs:` 已经能把
  `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `KIMI_CODE_HOME` / `COPILOT_CONFIG_DIR`
  注入到真实 CLI 子进程，**执行链路今天就能隔离，零改动**。
- 唯一可能的硬约束是 macOS Keychain（claude），**需要实测**。

RFC 0035（daemon 共享）依赖本 RFC：**「A 的机器上跑一个属于 B 的 daemon」本质上就是
「一台机器跑两个互不干扰的实例」，共享只是在这之上加一个别人的 token。**
先把多实例做干净，0035 就从「一份少一个就 SIGKILL 掉主 daemon 的注意事项清单」
退化成薄薄一层。

## 为什么这是本质问题（不止是为了共享）

多实例这件事本身就有独立价值，共享只是其中一个消费者：

- **本仓库的 dev E2E 流程今天就是坏的。** `CLAUDE.md` 写的
  `./bin/conductor-dev daemon --config-file ~/.conductor/config-dev.yaml`
  与用户自己的正式 daemon **共用** `~/.conductor` 下的 sessions / logs / cache /
  locks / state，并且抢同一个 `~/ws/daemon.pid`。
  （`--config-file` 只影响 config 路径，**不推导 `CONDUCTOR_HOME`**，见卡点 A-1。）
- 一个人有两个 Conductor 账号（个人 / 公司）。
- CI 上并行跑多个 daemon。
- 一台机器上同时接多个后端环境（prod / staging）。

## 现状：隔离一个实例，今天需要同时设对 6 个环境变量

```
CONDUCTOR_HOME            # config/logs/sessions/cache/locks/state
CONDUCTOR_WS              # workspace root —— 也决定 daemon.pid，且不由 CONDUCTOR_HOME 推导
CONDUCTOR_DAEMON_NAME     # 否则两边都是 os.hostname()
CONDUCTOR_SERVE_AI_PORT   # serve-ai 默认 127.0.0.1:8787
CHAT_WEB_HOME             # ~/.chat-web 浏览器 profile
KIMI_CODE_HOME            # ~/.kimi-code 凭据
```

**六根轴，互不推导，漏一根就出事**，而且没有任何一处文档把它们列在一起。
这就是问题的形状：机制零件有了，但没有「实例」这个概念把它们绑成一个整体。

设漏的后果不是降级而是**破坏**：

- 漏 `CONDUCTOR_WS` → 两个 daemon 抢 `~/ws/daemon.pid`。后启动的那个若带 `--force`，
  会 `SIGTERM → SIGKILL` **掉另一个实例**（`cli/src/daemon.js:2725-2760`）；
  不带 `--force` 则直接拒绝启动。更糟的是谁后启动谁把 `daemon.pid` 覆盖成自己的 pid
  （`:2787`），于是下一次 `--force` / restart 打到错误的进程上。
- 漏 `CONDUCTOR_DAEMON_NAME` → 同一个账号下两个 daemon 同名，
  realtimeHub 的 `takeOverAgentHost` 会互相踢下线，形成振荡。
- 漏 `CONDUCTOR_HOME` → 见下面 B-1 的 active-fire marker 互删。

## 卡点分级

### A 类：机制已有，但没收敛（改动小，收益最大）

- **A-1 `--config-file` 不推导 `CONDUCTOR_HOME`。**
  `resolveConductorConfigPath()` 认显式路径，`resolveConductorHome()` 只认
  `env.CONDUCTOR_HOME`，从不看 config 文件所在目录（`cli/src/conductor-paths.js:35-53`）。
- **A-2 `daemon.pid` 挂在 `WORKSPACE_ROOT` 而不是 `CONDUCTOR_HOME` 下。**
  `cli/src/daemon.js:2707`、`cli/bin/conductor-daemon.js:112-120`。
  workspace 是「用户数据放哪」，pid 锁是「实例运行时状态」，两者被绑在一起是个语义错误。
- **A-3 resolver 有四份实现，已经漂了。**
  `cli/src/conductor-paths.js` / `modules/conductor-sdk/src/paths.ts` /
  `modules/ai-sdk/src/manager/paths.ts` / `modules/ai-sdk/src/shared.js:305`（手写第四份）。
  漂移的证据就是 B-2。
- **A-4 import-time 常量。**
  `modules/conductor-sdk/src/session/store.ts:8-9`、
  `modules/ai-sdk/src/manager/paths.ts:47-63`、`cli/bin/conductor-daemon.js:21`
  在模块加载时就把 `CONDUCTOR_HOME` 固化了。
  后果：**`CONDUCTOR_HOME` 只能靠继承，永远不能在进程内运行时设置。**
  → profile 的实现必须是「spawn 时注入 env」，不能是「进程内切换」。
- **A-5 `dotenv.config()` 在 `cli/src/daemon.js:72` 读 **cwd** 的 `.env`，且在一切之前。**
  从哪个目录启动 daemon 会影响它的 profile 解析。profile 的优先级链必须显式定义。

### B 类：我们自己的代码硬编码（小改，但必须逐个找出来）

- **B-1 active-fire marker 会删掉同目录下其它实例的 marker。**（实测复现，但影响面有限）
  `cli/bin/conductor-fire.js:1591-1603`：写完自己的 marker 后，遍历 `stateDir`
  把所有其它 `active-fire.task_*.json` **`unlinkSync` 掉**。
  **仅影响没有 project 路径的手工 fire** —— 有 project 的 fire 写的是
  `<project>/.conductor/state`，天然隔离（见「实测结论」的修正说明）。
- **B-1b `--force` 是一条跨身份的 kill 原语**（实测复现，**优先级最高**）。
  `daemon --force` 读 workspace 下的 `daemon.pid` 并 `SIGTERM → SIGKILL`，
  **完全不校验那个进程属不属于同一个账号/实例**。
- **B-2 `~/.conductor/dsh-sessions` 硬编码，无视 `CONDUCTOR_HOME`。**
  `modules/ai-sdk/src/providers/dsh-sdk-session.js:56`。
- **B-3 `~/.cache/conductor/.chrome-port` 硬编码，是个真单例。**
  `cli/bin/conductor-chrome.js:48-49`。第二个实例会劫持第一个实例的浏览器。
- **B-4 `~` 展开实现不统一。**
  `cli/src/custom-command-handlers.js:253` 用裸 `os.homedir()`（无视 `env.HOME`）；
  `modules/ai-sdk/src/resume/shared.js:15-19` `resolveHomeDir()` 同样只认
  `options.homeDir`，不认 `env.HOME`。
- **B-5 `CHAT_WEB_HOME` 自成体系**（`modules/chat-web/src/core/paths.ts:11-32`），
  不在 conductor 的 profile 体系里。共用会撞 Chrome 的 singleton lock。

### C 类：需要设计取舍

- **C-1 custom-command / remote-exec 子进程被整体剥掉 `CONDUCTOR_*`。**
  `cli/src/custom-command-handlers.js:307-317`、`cli/src/remote-exec-handlers.js:317-323`
  删掉所有 `CONDUCTOR_` 前缀变量，只回填 `CONDUCTOR_CONFIG_FILE`。
  于是**脚本里再调 `conductor …` 会退回 `~/.conductor`，跑到默认实例上去**。
  这个剥离本来是防 token 泄漏的，现在和 profile 隔离直接冲突 —— 需要区分
  「敏感变量（token/backend）要剥」和「路径变量（HOME/WS）要保留」。
- **C-2 全局 npm/pnpm prefix。** 自更新与 node-pty 重建（`cli/src/native-deps.js:176-205`）
  作用于全局包根，两个实例可能并发 `pnpm add -g`。
  多实例下「谁负责自更新」需要一个明确答案（建议：非默认 profile 不自更新）。
- **C-3 共享 tmux server。** `daemon.js:1370-1385` 调 tmux 时没有 `-L` / `-S`，
  用的是 OS 用户默认 socket。session 名是 task UUID，不会撞；但**共享故障域**：
  一边把 tmux server 搞挂，另一边的 fire 一起死。
  可能的解法是给每个实例设 `TMUX_TMPDIR` 或加 `-L <profile>`（待验证）。
- **C-4 同一个 project 被两个实例绑定**时共用 `<project>/.conductor/worktrees/` 和
  `settings.yaml`。多实例语义下这算不算合法用法，要先定义。

### D 类：AI CLI 凭据 —— **执行链路今天就能隔离，零改动**

这块的结论和预期相反：**机制已经有了，而且粒度恰好是「每个实例」。**

`config.yaml` 里的 `envs:` 会被**整体展开**进每一个 provider 拉起的 CLI 子进程
（`modules/ai-sdk/src/shared.js:354-360` `loadEnvConfig`，7 个 built-in provider
各自做同样的 merge，例如 `claude-agent-sdk-session.js:618-624`、
`codex-app-server-transport.js:155-160`）。而 `envs:` 来自 config 文件，
**天然就是 per-instance 的**。所以今天写：

```yaml
# 实例 A 的 config.yaml
envs:
  CLAUDE_CONFIG_DIR:  ~/ai-identities/a/claude
  CODEX_HOME:         ~/ai-identities/a/codex
  KIMI_CODE_HOME:     ~/ai-identities/a/kimi-code
  COPILOT_CONFIG_DIR: ~/ai-identities/a/copilot
```

**task 执行链路的 AI 身份就已经分开了，一行代码都不用改。**
（daemon → fire → worker → provider → 真实 CLI 这条 env 链是完整的：
`daemon.js:6389` → `client.js:82` `env: process.env` → provider `{...process.env, ...this.env}`。）

真正的缺口收窄成三条：

- **D-1 `AiManager`（配额面板 / 账号切换）不认 `envs:`，硬编码 `homedir()`。**
  `modules/ai-sdk/src/manager/paths.ts:48` `DEFAULT_CODEX_AUTH = join(homedir(), ".codex", "auth.json")`；
  `quota/claude.ts:60` 同理。后果：**执行用的是隔离后的凭据，配额面板读的却是全局的**，
  两边对不上；更糟的是 `switch_account`（`manager/account.ts:145`）会写全局那份。
  修法约 30 行：`paths.ts:48-51` 改成读 `process.env.CODEX_HOME`，
  `quota/claude.ts:60` 认 `CLAUDE_CONFIG_DIR`。
  彻底一点是给 `AiManagerOptions` 加一个 `env` 包并 thread 到各 `get*Quota`（约 150 行）。
- **D-2 `chat-web` 不读 `envs:`。**
  `CHAT_WEB_HOME` 有效，但 `chat-web-session.js` 从不调 `loadEnvConfig`，
  只认 daemon 进程自己的 env。所以它必须由 profile 在**进程级**注入，不能靠 `envs:`。
- **D-3 kimi 的 legacy `~/.kimi/` 回退路径**（`paths.ts:57-62`）硬编码 `homedir()`：
  实例 B 若没有 `.kimi-code` 凭据，会**静默回退到共享的旧文件**。

### D 类**不在 RFC 0035 的关键路径上**

0035（daemon 共享）的出发点就是**共享 AI 工具的 token** —— guest 要用的正是
A 机器上已经登录好的那套 CLI。所以 guest 的 config **不写 `envs:`**，
让它继承全局 `~/.claude` / `~/.codex`，这是**刻意的设计，不是妥协**。

推论：
- 下面这条 Keychain 的硬约束，以及 D-1 / D-2 / D-3 三条缺口，
  **只影响「一台机器登两个 AI 账号」这个独立场景，不阻塞 0035。**
- 反过来说，0035 需要 0036 的只有 **Conductor 自身状态的隔离**（A / B / C 类），
  AI 那一层要的恰恰是**不隔离**。
- 因此 profile 的默认语义应该是：**Conductor 状态默认隔离，AI 凭据默认共享，
  写 `envs:` 才隔离**。这正好是今天的行为，不需要改设计。

### D 类的唯一硬约束：macOS Keychain（仅影响多 AI 账号场景）

- 🔴 **claude**：`security find-generic-password -a $USER -s "Claude Code-credentials"`
  （`quota/claude.ts:74-88`）。Keychain 条目按 **OS 用户**存，没有 per-instance 维度。
  `CLAUDE_CONFIG_DIR` 能搬走 settings/projects/tasks，
  **但是否能把 OAuth 凭据也从 Keychain 搬走，需要实测验证**——这是本 RFC 唯一一个
  「不实验就不知道」的问题。
  兜底方案：给实例 B 在 `envs:` 里配独立的 `ANTHROPIC_API_KEY` /
  `CLAUDE_CODE_OAUTH_TOKEN`（`quota/claude.ts:34-37` 优先读 env）。
- 🟡 **copilot**：同样有 Keychain（`quota/copilot.ts:18`），但
  `COPILOT_CONFIG_DIR/config.json` 会被**先**尝试（`:814-816`），所以实际可隔离。

### 顺带澄清：没有 `gemini` CLI 后端

`web-gemini` 是 `chat-web` runtime + `--model gemini` 的别名
（`cli/bin/conductor-config.js:62-66`）。真实后端清单见
`modules/ai-sdk/src/built-in-backends.js:34-72`：
`codex, claude, copilot, kimi, opencode, chat-web, dsh`。

## 好消息

- `CONDUCTOR_HOME` **确实会传给 fire 子进程**：`cli/src/daemon.js:6389`、`:7098` 都是
  `{ ...stripPtyTaskScopedEnv(process.env), ...materializedConductorPathEnv, ... }`，
  且 `PTY_TASK_SCOPED_ENV_KEYS`（`:698-705`）不含它；tmux 模式下也会被逐个
  `-e KEY=VALUE` 重新注入（`:1355-1367`）；fire → AI CLI 的各 transport 都是
  `...process.env` 透传。**主链路是通的，缺的是收敛和补齐边角。**
- `envForExplicitConfigFile`（`cli/src/config-env.js`）只删 token / backend 四个变量，
  **不动 `CONDUCTOR_HOME`** —— 正好是 profile 需要的语义（身份要隔离，路径要继承）。

## 方案草案：把 profile 变成一等公民

```
conductor --profile <name>      # 或 CONDUCTOR_PROFILE=<name>
```

单一 resolver 算出全套路径，其余一切从它派生：

```
~/.conductor/profiles/<name>/
├── config.yaml          → CONDUCTOR_CONFIG
├── logs/ sessions/ cache/ locks/ state/
├── ws/                  → CONDUCTOR_WS（daemon.pid 迁到 run/ 更好，见 A-2）
├── run/daemon.pid       → 实例锁
└── ai/                  → CODEX_HOME / CLAUDE_CONFIG_DIR / KIMI_CODE_HOME / CHAT_WEB_HOME
```

- 默认 profile 解析回 `~/.conductor` + `~/ws`，**零行为变化**，老用户无感。
- daemon 启动时把整套路径 materialize 进 `process.env`，所有子进程无脑继承
  （A-4 决定了这必须在 spawn 时做）。
- `conductor profile list|create|remove`，`conductor daemon --profile` / `fire --profile`。
- 四份 resolver 收敛成一份（A-3），其余三处改成 re-export。

## 实测结论（2026-08-30，已跑完）

用**已发布的 0.10.0**（不是改过的代码）+ 一次性 sqlite DB + 本地 6152 后端，
在一台 macOS、同一个 OS 用户下注册两个账号、起两个 daemon 实测。**结论：核心假设成立。**

| # | 实验 | 结果 |
| --- | --- | --- |
| E1 | 两个账号的 daemon，各自 `CONDUCTOR_HOME` + `CONDUCTOR_WS` + `daemon_name` | ✅ **共存**，各自 `/api/agents` 只看到自己那台 |
| E2 | 两个账号的 daemon **同名**（都叫 `exp-daemon-a`） | ✅ **不互踢**，两条连接 id 不同，各自可见。证实 hub 按 `(userId, host)` 分区 |
| E3 | 两个 daemon 共用同一个 `CONDUCTOR_WS`（不带 `--force`） | ✅ 安全失败：后者拒绝启动 `Daemon already running with PID 57959`，前者存活 |
| E3b | 同上但**带 `--force`** | 🔴 **后者 SIGKILL 掉了前者**（exit 143），A 的 agent 列表清空。**跨账号的进程击杀，实测复现** |
| E4 | active-fire marker 互删 | ✅ 复现，但**影响面比原先记录的窄**，见下 |
| E5 | 用户 B 在自己的 daemon 上建 project + 跑 `claude` task | ✅ 跑通，返回 `SHARED_AI_OK`，**用的是本机共享的 `~/.claude` 登录态** |
| E6 | A 和 B **同时**各跑一个 claude task | ✅ 同一秒完成（`23:28:49`），各自返回 `A_OK` / `B_OK`，互不干扰 |

### 对 RFC 0035 的意义

E1 + E2 + E5 合起来就是 0035 的核心假设：
**「A 的机器上跑一个属于 B 的 daemon，B 像用自己的机器一样建任务、用 A 已登录的 AI 工具」
—— 今天零改动就能跑通。** 0035 的后端改动量因此确认为「几乎为零」，
真正的工作量在 share 授权流程 + supervisor + UI。

E2 还带来一个设计放宽：`guestHost` **不需要全局唯一**，只要在 B 的命名空间内唯一即可。
`shared-` 前缀保留是为了 UX（让 B 一眼看出不是自己的机器），不是正确性要求。

### 需要修正前文的两处

- **E4：marker 互删的影响面被我高估了。**
  `resolveFireStateDir(workingDirectory, env)` 的优先级是
  `CONDUCTOR_FIRE_STATE_DIR` → `<workingDirectory>/.conductor/state` → `$CONDUCTOR_HOME/state`，
  而 `writeFireTaskMarker(taskId, workingDirectory = process.cwd())` 默认传 cwd。
  所以**有 project 路径的 fire 写的是项目内的 `.conductor/state`，天然隔离**；
  只有**没有 project 路径的手工 fire** 才落到共享的 `$CONDUCTOR_HOME/state` 并互删。
  （实测：`resolveFireStateDir("")` → `$CONDUCTOR_HOME/state`，
  两次不同 taskId 的写入后目录里只剩最后一个。）
  仍然要修，但它是「手工 fire 的边角」，不是「所有 task 的数据损坏」。
- **E3b 是目前最该先修的一条**：`--force` 的语义是「停掉已有 daemon」，
  但它认的是 workspace 里的 pid 文件，**根本不检查那个进程属不属于同一个身份**。
  多实例场景下这是一条跨账号的 kill 原语。

### 还没验证的

- **OAuth token 刷新的并发竞争**：E6 只证明了并发*使用*同一份凭据没问题，
  跑的是短单轮任务，没有触发 token 刷新。**并发*刷新*仍未验证**，
  需要构造凭据临过期的场景，或长时间高并发跑。风险评估维持原状。
- macOS Keychain 能否被 `CLAUDE_CONFIG_DIR` 绕开（与 0035 无关，缓做）。

### 复现方法

```bash
# 后端：一次性 DB，不碰已有 dev.db
DATABASE_URL="file:/tmp/exp-conductor/dev.db" pnpm db:push && pnpm build
DATABASE_URL="file:/tmp/exp-conductor/dev.db" PORT=6152 pnpm start
# 注册两个账号 → POST /api/auth/request-code，从 verifications 表取 code → /api/auth/register
# 各自 POST /api/auth/tokens 铸 agent token，写进各自 config.yaml
# 两个 daemon：
CONDUCTOR_HOME=/tmp/exp-conductor/home_a CONDUCTOR_WS=/tmp/exp-conductor/ws_a   conductor daemon --config-file /tmp/exp-conductor/home_a/config.yaml
CONDUCTOR_HOME=/tmp/exp-conductor/home_b CONDUCTOR_WS=/tmp/exp-conductor/ws_b   conductor daemon --config-file /tmp/exp-conductor/home_b/config.yaml
```

## 推荐路径（按「能立刻验证」排序）

**Step 0 — ~~先做一次实验~~ ✅ 已完成，见上面「实测结论」**
手工造两个实例，验证「零改动多实例」到底能走多远：

```
CONDUCTOR_HOME=~/.conductor-b  CONDUCTOR_WS=~/ws-b  CHAT_WEB_HOME=~/.chat-web-b \
  conductor daemon --config-file ~/.conductor-b/config.yaml
# config.yaml 里: daemon_name: box-b, envs: { CODEX_HOME: ..., CLAUDE_CONFIG_DIR: ... }
```

要回答的问题（**按对 0035 的重要性排序**）：
1. 两个 daemon 能否稳定共存（锁、连接、心跳、互不踢线）？—— 0035 的关键路径
2. 两个实例**共用同一套 AI 凭据**时，并发跑 task 会不会互相干扰
   （尤其是 OAuth token 刷新的竞争）？—— 0035 的关键路径
3. `CLAUDE_CONFIG_DIR` 能不能把 OAuth 凭据从 macOS Keychain 搬走？
   —— **与 0035 无关**，只决定「多 AI 账号」这个独立场景的上限，可以缓做

第 1、2 条跑通，0035 的可行性就确定了，不需要等第 3 条。

**Step 1 — B 类硬编码修掉（小，独立可合）**
active-fire marker 互删（B-1，这条是数据损坏，独立于多实例也该修）、
`dsh-sessions`（B-2）、`.chrome-port`（B-3）、`~` 展开统一（B-4）。

**Step 2 — profile 一等公民（A 类）**
四份 resolver 收敛成一份；`--profile` / `CONDUCTOR_PROFILE`；
默认 profile 解析回 `~/.conductor` + `~/ws` 保证零行为变化；
daemon 启动时把整套路径 materialize 进 `process.env`（A-4 决定必须在 spawn 时做）。

**Step 3 — AiManager 对齐（D-1）**
让配额面板 / `switch_account` 和执行链路读同一份凭据。约 30 行起步。

**Step 4 — C 类取舍**
custom-command / remote-exec 的 env 剥离规则（C-1）；自更新归属（C-2）；tmux socket（C-3）。

## 与 RFC 0035 的关系

0035 的 guest daemon = 「一个 profile + 一个别人的 token」：

```
conductor daemon --profile share-<shareId>
  config.yaml: { agentToken: <B 的 scoped token>, daemonName: shared-... }
```

0035 里那份「`CONDUCTOR_HOME` / `CONDUCTOR_WS` / `CONDUCTOR_FIRE_STATE_DIR` 少一个就
SIGKILL 掉 A 的 daemon」的注意事项清单，在本 RFC 落地后**整体消失**。

## Open Questions

1. ~~profile 的粒度：AI 凭据隔离还是共享~~ ✅ 已有答案：
   `envs:` 是**可选的**，不写就继承机器上的全局 AI 凭据。
   - RFC 0035 的共享场景：**不写 `envs:`** → guest 复用 A 登录好的 CLI（正是卖点）。
   - 「一台机器两个 AI 账号」场景：**写 `envs:`** → 完全隔离。
   同一个机制覆盖两种需求，profile 不需要强制 `ai/` 目录。
2. `daemon.pid` 迁到 `$CONDUCTOR_HOME/run/` 是破坏性变更（升级时的旧锁怎么办）。
3. C-1 的敏感变量剥离规则由谁定义 —— 需要一份显式的 allow/deny 清单。
4. 非默认 profile 是否禁用自更新（C-2）。
5. **需要实测（但不阻塞 0035）**：`CLAUDE_CONFIG_DIR` 能否把 claude 的 OAuth 凭据从
   macOS Keychain 搬走？只决定「macOS 上能否跑两个不同 Claude 账号」。
7. **需要实测（阻塞 0035）**：两个实例共用同一份 `~/.codex/auth.json` /
   claude 凭据并发跑 task 时，OAuth token 刷新会不会互相踩？
   我们自己的写入是 tmp + rename 原子的（`manager/account.ts:143-147`），
   但上游 CLI 自己的刷新逻辑不受我们控制。
   注意这个风险**今天就存在**（单用户多 fire 并发），共享只是把概率放大。
6. `envs:` 目前是全局的（对所有 backend 生效）。要不要支持 per-backend 的
   `allow_cli_list.<backend>: { command, env }`？（provider 侧的 `options.env`
   管道已经存在，只差 `conductor-fire.js:999` 不传。）MVP 不需要。
