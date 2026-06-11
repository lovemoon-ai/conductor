# ai-sdk × claude-agent-sdk: bundled cli.js 过旧，新增的 model alias 直接 404

- Date: 2026-06-11
- Module: `modules/ai-sdk/src/providers/claude-agent-sdk-session.js`、`modules/ai-sdk/package.json`
- Surfaced by: 线上任务 `4331fb4e-da86-46a1-bc91-b042978ed170`（m1 daemon，`backend=claude-fable-low`），SDK 直接抛 `There's an issue with the selected model (fable). It may not exist or you may not have access to it.`

## 症状

用户 `~/.conductor/config.yaml` 里有：

```yaml
allow_cli_list:
  claude-fable-low: claude --model fable --effort low
```

手动 `claude --dangerously-skip-permissions --model fable --effort low` 完全正常。但 conductor fire 经 ai-sdk 走同一条配置就 100% 失败，错误信息暗示模型不存在。

## 根因

`ai-sdk` 不是 spawn 用户系统的 `claude` 二进制，而是用 `@anthropic-ai/claude-agent-sdk` 的 `query()` API，这个 SDK **自带一份 `cli.js`**：

| 路径 | 对应 Claude Code 版本 | 是否认识 `fable` |
|---|---|---|
| `which claude` (系统全局) | 2.1.170 | ✅ |
| `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` (SDK 自带) | **2.1.72** | ❌ |

`modules/ai-sdk/package.json` 里 pin 的是 `"@anthropic-ai/claude-agent-sdk": "^0.2.72"`，npm 上 latest 已经是 **0.3.173**。caret 跨 minor 不会自动升，所以这台机器一直在用 0.2.72 配 2.1.72 的旧 binary。`fable` 是后来加入的 alias，2.1.72 不识别 → 报"模型不存在"。

本地复现完全一致：

```
$ node modules/ai-sdk/node_modules/@anthropic-ai/claude-agent-sdk/cli.js \
    --dangerously-skip-permissions --model fable --print "ping"
There's an issue with the selected model (fable). It may not exist or you may
not have access to it. Run --model to pick a different model.
```

**第二个共生问题**（不是这次报错的直接原因，但 alias 写完一定踩到）：
`cli/bin/conductor-fire.js` 的 `extractAiSessionOptionsFromCommandLine` 只识别 `--model`，`--effort low` 被静默吞掉，传不到 SDK。即使 SDK 升级了认识 `fable`，effort 也不会生效。

## 修复

1. **升级 SDK**：`modules/ai-sdk/package.json` `@anthropic-ai/claude-agent-sdk` `^0.2.72` → `^0.3.173`。
   - 0.3 起 SDK 把 binary 拆成 `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` 可选依赖（macOS arm64 上是 `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`），bundle 的是 Claude Code 2.1.173，认识 `fable`。

2. **让 `--effort` 不丢**：放在 claude session 内部，不污染 fire 层。
   - `modules/ai-sdk/src/shared.js` 新增 `extractLongFlagFromCommandLine(commandLine, flag)` 工具。
   - `ClaudeAgentSdkSession` 的 constructor 在 `options.effort === undefined && options.commandLine` 时回填，显式 `options.effort` 永远胜出。

回归测试：
- `modules/ai-sdk/test/claude-agent-sdk-session.test.js` 新增 5 个 case：默认从 commandLine 解析、`--flag=value` 语法、显式 override、`buildSdkOptions` 透传、无 flag 兜底。
- `cli/test/conductor-fire-args.test.js` 新增 4 个 case 锁死 fire 层只解析 `--model`，不让 `--effort` 反向悄悄回到 fire 层（否则 codex 等 backend 的 `--effort` 语义可能被劫持）。

## 设计取舍：为什么 `--effort` 不放在 fire 层白名单

第一版 PR 把 `AI_SESSION_OPTION_FLAGS = ["model", "effort"]` 放在 `cli/bin/conductor-fire.js`，被 review 指出是抽象泄漏 —— `--effort` 只对 Claude/Codex 等 reasoning model CLI 有意义，fire 层不应该知道。

最终归位：

| 层 | 职责 | 知道哪些 flag |
|---|---|---|
| fire / serve-ai | 把命令行 lift 成结构化 session options + backend routing | 只有 `--model`（所有 backend 通用，且参与 routing 决策） |
| `ClaudeAgentSdkSession` | Claude provider 内部 | 自己挖 `--effort` |
| `shared.js` | 通用工具 | 提供 `extractLongFlagFromCommandLine`，留给其它 provider 想挖自己 flag 时复用 |

工具 backend-agnostic，调用方 backend-specific —— 这是 helper 跨层不污染上层的正确方式。

## 如何下次避免

1. **任何 vendored / bundled CLI 都要锁 minor，并写一个"上游 minor bump → 我们这一侧也要 bump"的提醒**。`@anthropic-ai/claude-agent-sdk` 0.2 → 0.3 把 cli.js 拆成 platform package、版本号不再跟主版本对齐，caret `^0.2.72` 永远等不到升级。后续凡是 vendored CLI 类 SDK，写 changeset 时强制 pin `~0.2.x` 或在 README 里挂"上游版本对应表"。

2. **alias-only 的 backend 必须有 E2E smoke**。`claude-fable-low` 这种纯 CLI flag 组合的 alias，光看 conductor 这一侧的单测全过没意义 —— 真正失败的是 SDK 自带 binary 不支持 `fable`。`conductor diagnose <task>` 出 404 / snapshot 时，第一时间手动用 `node modules/ai-sdk/node_modules/.../cli.js --model X --print "ping"` 本地复现，绕过 conductor 链路定位 SDK 边界。

3. **新增 backend-specific flag 时，优先看 provider 的 session 类有没有 `commandLine` 透传**。
   - 看 `cli/bin/conductor-fire.js:994` 那行 `commandLine: sessionCommandLine`：所有 session 类都已经拿到了原始命令行。
   - 不要再往 fire 层 / serve-ai 层加 backend-specific 的 flag 白名单，直接在对应 session 类自己解析。

4. **诊断"线上任务 X 报 Y 错"时，先确认是否能 reproduce 出 Y**。这次是把 `--model fable --print "ping"` 喂给 SDK 自带的 cli.js，直接复现了一模一样的报错串，从而把锅扣到"SDK 版本/binary 版本"而非 conductor 链路上。`conductor diagnose` 返回 404 不等于无证可查 —— 能在源码侧重现，就比 live data 还硬。

## 相关代码

- `modules/ai-sdk/package.json`（SDK 版本 bump）
- `modules/ai-sdk/src/shared.js`（`extractLongFlagFromCommandLine`）
- `modules/ai-sdk/src/providers/claude-agent-sdk-session.js`（constructor 回填 `effort`、`buildSdkOptions` passthrough）
- `modules/ai-sdk/test/claude-agent-sdk-session.test.js`
- `cli/test/conductor-fire-args.test.js`
- `.changeset/claude-effort-from-commandline.md`
