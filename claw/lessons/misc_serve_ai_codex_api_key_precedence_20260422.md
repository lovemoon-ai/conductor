# Symptom

`conductor serve-ai` 使用 Codex backend 时，请求会失败并返回认证错误；但同一台机器上的交互式 Codex 又是可用的。

用户侧表现为：

- `serve-ai -> codex exec` 失败
- 报错是 OpenAI `401 Unauthorized`
- 看起来像 `serve-ai` 自己的鉴权逻辑有问题

# Root Cause

`serve-ai` 会继承父进程环境。当前 shell 环境里存在失效的 `CODEX_API_KEY`，而 Codex CLI 会优先使用它，而不是 `~/.codex/auth.json` 中的登录态。

所以：

- 手工交互式 Codex 可能还能走本地 auth
- `serve-ai` 拉起的 codex 子进程却被坏的 `CODEX_API_KEY` 劫持

# Fix

- 在 `serve-ai` 创建 codex session 时默认传 `ignoreCodexApiKey: true`
- `codex exec` 和 `codex app-server` 两条路径在 spawn 子进程前都删除 `CODEX_API_KEY`
- 让 Codex 优先回退到 `~/.codex/auth.json`

# How To Avoid Next Time

- 对会读取多种认证来源的 CLI，接入时要明确“环境变量优先级”和“本地 auth 文件优先级”
- 真实 e2e 失败时，先验证“同一个 shell 里直接运行底层 CLI 是否也失败”
- 对高优先级认证环境变量，给 `serve-ai` 这类桥接层保留显式忽略选项
