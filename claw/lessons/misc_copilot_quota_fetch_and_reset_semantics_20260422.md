# Copilot Quota Fetch And Reset Semantics

## Symptom
- `ai-manage` 前端显示 `copilot SDK returned no quota snapshots`，即使本机 Copilot CLI 已登录且账号实际有 quota。
- 部分 Copilot 账号的 reset 时间显示错误；只有日期的返回值会在本地时区里被渲染成前一天傍晚或当天早晨的具体时间。

## Root Cause
- 实现只依赖 Copilot SDK `account.getQuota()` 的旧快照格式，没有兼容当前 Copilot CLI 使用的 `/copilot_internal/user` 返回结构。
- 新接口里有限额账号会返回 `limited_user_quotas`、`monthly_quotas` 和 `limited_user_reset_date`。其中 `limited_user_reset_date` 只有日期语义，但代码直接用 `Date.parse()` 把它当成 UTC 时间点。

## Fix
- 当 SDK quota snapshots 为空时，回退请求 `/copilot_internal/user`，并兼容 `quota_snapshots` 与 `limited_user_quotas + monthly_quotas` 两种结构。
- 读取 Copilot 本地登录 token 时优先使用本地登录态，并在 macOS 上兼容 keychain 的 `copilot-cli` 条目。
- 为 quota window 增加 `resetOnDate`，将 `YYYY-MM-DD` 这类仅日期值保留为日期语义，前端只显示日期，不伪造时分。
- 补充解析测试与前端渲染测试，覆盖空快照回退和日期型 reset。

## Avoid Next Time
- 对第三方 CLI / SDK 的 quota 接口不要假设返回结构长期稳定；接入时要为新旧结构保留兼容层。
- 遇到 provider 返回的日期字段时，先区分“时间点”与“日级语义”，不要默认用 `Date.parse()` 转成绝对时间。
- 对 quota 展示链路至少补两类测试：真实返回样例解析测试，以及前端最终展示测试。
