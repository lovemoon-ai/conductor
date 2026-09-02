# arch: ai-sdk ignored `CLAUDE_CONFIG_DIR` (Claude quota blank + resume broken on shared L20)

## 症状

前端在 `shared-2620-l20` 这台 demo 机器上看不到 Claude 的余额（quota）。
后端 API 返回的是空额度 + 错误串：

```
GET /api/ai-manager/quota?agentHost=shared-2620-l20&tool=claude&forceRefresh=1
{"claude":{"source":"unknown",
  "error":"no Claude credential found (ANTHROPIC_API_KEY env, macOS Keychain, or ~/.claude/.credentials.json)",
  "fiveHour":{"usedPercent":0,"remainingPercent":0}, ...}}
```

同一台机器上 `claude` CLI 本身是能正常登录、正常跑任务的，所以不是掉登录。

## 根因

L20 上 Claude Code 的配置目录被搬到了网络存储，daemon 进程环境里带着：

```
HOME=/root
CLAUDE_CONFIG_DIR=/vepfs-pykaxon/yueyu/claude-sessions   # 凭证/会话真实位置
```

`/root/.claude` 根本不存在。

而 ai-sdk 里两处都把 `~/.claude` 当成了硬编码常量，完全没有读 `CLAUDE_CONFIG_DIR`：

1. `modules/ai-sdk/src/manager/quota/claude.ts` → `resolveClaudeCredential()`
   只找 `ANTHROPIC_API_KEY` → macOS Keychain → `join(homedir(), ".claude", ".credentials.json")`。
   在 L20 上三条全落空 → 返回 `null` → `getClaudeQuota()` 直接短路成空额度，
   **一次网络请求都没发**，所以前端只能显示空白。

2. `modules/ai-sdk/src/resume/claude.js` → `findSessionPath()`
   同样在 `~/.claude/projects` 和 `~/.claude/tasks` 下面找会话。
   同一个原因，在 L20 上恢复会话一律返回 `null`（这是被顺带发现的第二个实例）。

## 修复

两处都改成认显式的 `CLAUDE_CONFIG_DIR`，但**共用一个 resolver**：
`manager/paths.ts` 新增 `resolveClaudeConfigDirs(env, homeDir?)`，返回**按优先级排好的目录列表**
`[$CLAUDE_CONFIG_DIR, ~/.claude]`，quota 和 resume 都用它。

关键决策（都是 code review 时才想清楚的，第一版是错的）：

- **是"先找 override，再回落 `~/.claude`"，不是"用 override 替换 `~/.claude`"。**
  第一版 resume 直接把 `~/.claude` 换掉了，结果是：一台机器先用默认目录跑过 Claude，
  之后才 export `CLAUDE_CONFIG_DIR`，那些旧会话会**全部变成不可恢复**
  （`findSessionPath` 返回 null → `Invalid --resume session id`）。
  更糟的是 quota 那一半当时是有回落的，两半行为不一致。
- **config dir 排在 Keychain 前面，但必须检查 `expiresAt`。**
  这条差点重犯本仓库已经记录过的 bug（见 memory `claude-auth-keychain-stale-file`）：
  macOS 上 Claude Code 刷新 token 是写进 Keychain 的，磁盘上那份 `.credentials.json` 会变成死的。
  只按优先级返回、不看过期时间的话，一份陈旧的 `$CLAUDE_CONFIG_DIR/.credentials.json`
  会**盖住可用的 Keychain 凭证**，直接 401。
  现在的逻辑是：按顺序找**第一个没过期的**；全都过期了就返回那个过期的，
  让调用方报 401（真实且可操作），而不是报"没找到凭证"（误导）。
- **`~` 展开。** RFC 0036 里 config.yaml `envs:` 的写法就是 `CLAUDE_CONFIG_DIR: ~/ai-identities/a/claude`，
  这些值是直接塞进子进程 env 的，没有 shell 展开。不展开的话 `join("~/...", ".credentials.json")`
  会拼出一个字面量 `./~/...` 路径 → ENOENT → 又是一片空白。复用了 `paths.ts` 已有的 `expandHomeWithEnv`。
- **`options.env` 而不是只读 `process.env`。** `serve-ai` 会构造
  `runtimeEnv = {...process.env, ...runtimeConfig.envs}` 再作为 `env:` 传给 session
  （`cli/src/serve-ai/index.js:436`）。`resume/kimi.js` 的 `resolveKimiCodeHome` 已经认 `options.env`，
  claude 这边不认的话，通过 config.yaml `envs:` 做多身份隔离时 kimi 生效、claude 不生效。
- **显式 `options.homeDir` 优先于环境变量**，那是测试 seam；反过来的话开发机上
  export 了 `CLAUDE_CONFIG_DIR` 就会把测试跑挂。
- 顺手给 `findClaudeSessionEntries` 加了**命中即返回**（改名 `findClaudeSessionPath`）。
  原来它会把所有 project 目录下每个 `.jsonl` 整个读到 EOF、收集全部匹配，而调用方只用 `[0]`。
  以前在本地盘上只是浪费，现在这个扫描被指向了网络存储，每次 resume 都是秒级甚至更久的网络 IO。

## 验证

不是只跑单测就算完，是在真机上做了 A/B：

```
# 修复前（L20 实测）
credential: null
error: "no Claude credential found ..."
BEFORE fix resolved: null

# 修复后（L20 实测，同一台机器同一份凭证）
credential: oauth expired: false
quota: {"source":"fresh","fiveHour":10,"weekly":1}
resume: /vepfs-pykaxon/yueyu/claude-sessions/projects/-root/2bda....jsonl
```

单测：`cd modules/ai-sdk && pnpm test` → 213 + 80 全绿。

**并且对每个新加的 guard 做了变异测试**（这点很重要，见下）：

| 把哪个 guard 改坏 | 失败用例数 |
|---|---|
| 去掉 `homeDir` 优先 | 1 |
| 去掉 `~/.claude` 回落 | 1 |
| 去掉 `expiresAt` 检查 | 1 |

## 下次怎么避免

- **不要把 `~/.claude`、`~/.codex`、`~/.kimi` 写成常量。** 每个 CLI 都有对应的
  home 覆盖变量（`CLAUDE_CONFIG_DIR`、`CODEX_HOME` …），共享机 / 容器 / 网络存储上
  这些变量一定会被用到。加新 provider 的凭证或会话查找时，先问"这个工具的 config dir 怎么被覆盖"。
- **override 语义默认是"优先"不是"替换"。** 凡是"按 id 查一个唯一对象"的场景
  （session id、凭证），搜完 override 再搜默认位置几乎总是对的：id 唯一所以不会有歧义，
  代价只是一次本地目录 stat，收益是不会让历史数据凭空消失。
- **凭证优先级一旦有多个来源，就必须带过期判断。** 否则"优先级高"会变成"优先返回一个死 token"。
  本仓库已经为这个踩过一次坑（memory `claude-auth-keychain-stale-file`），
  这次改优先级时差点原样复现。
- **凭证解析失败要能被看见。** `resolveClaudeCredential()` 返回 `null` 后
  `getClaudeQuota()` 直接返回空额度对象，前端拿到的 `usedPercent: 0` 和"真的用了 0%"
  长得一模一样，只有 `error` 字段里藏着线索。返回空值时错误信息要把**查过哪些路径**列全。
- **写了 guard 就要能证明它被测到。** 这次 review 抓到的最尴尬的一条是我自己写的
  `assert.notEqual(cred?.token, "")` —— 解析失败返回 `undefined`，`undefined !== ""` 恒真，
  这个断言**永远不会失败**；而且那个用例还会真的去 spawn `security find-generic-password`
  读开发机上真实的 Keychain。判断新用例有没有价值，最快的办法就是**把 guard 改坏跑一遍**，
  没有用例变红就说明没测到。凭证/路径这类代码还要额外确认用例是不是把真实机器状态
  （Keychain、真 `$HOME`）隔离掉了，否则就是台机器换一下结论就变。
- **这类"某台机器上不工作"的问题，先看 daemon 的进程环境，别看自己的 shell。**
  `tr '\0' '\n' < /proc/<daemon-pid>/environ` 一把就看出 `CLAUDE_CONFIG_DIR` 和 `HOME` 对不上。
- 修完一处硬编码路径，**顺手 grep 同一个 pattern**，同类 bug 基本不会只有一处 ——
  这次 resume 就是这么捞出来的。但注意 `grep -rn '/\.claude' src` 这种按**具体路径**搜的写法
  只能捞到 claude 自己，捞不到 codex/kimi 的同类问题；要按**模式**搜（`join(homedir()`）。

## 已知未修（follow-up）

- `resume/codex.js` 的 `findSessionPath` 和 `manager/paths.ts` 的 `DEFAULT_CODEX_AUTH`
  同样硬编码 `~/.codex`，不认 `CODEX_HOME`。**L20 上 `CODEX_HOME` 没有设置、`/root/.codex` 存在，
  所以目前没有实际故障**，属于潜在问题；等有机器真的用 `CODEX_HOME` 隔离时会以完全相同的方式爆掉。
  注意同一个文件里 `DEFAULT_KIMI_CODE_HOME` 是认 `KIMI_CODE_HOME` 的，三者不一致。
  彻底的做法见 RFC 0036 D-1：把 `env` 包一路穿到 `AiManagerOptions`/`paths.ts`。
