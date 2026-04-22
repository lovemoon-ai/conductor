# Copilot Install Version Placeholder

## Symptom
- daemon card 里的 Copilot version 显示为 `sdk`，不是实际版本号。

## Root Cause
- `ai-manager` 的 Copilot install 检测在确认 `@github/copilot-sdk` 可导入后，直接返回了硬编码的 `version: "sdk"` 占位值。

## Fix
- 改为先解析 `@github/copilot-sdk` 的实际入口文件路径，再向上查找所属 `package.json`，读取真实 `version` 字段。
- 增加单测，覆盖从模块入口路径回溯包版本的逻辑，避免再回退成占位字符串。

## Avoid Next Time
- install/status 卡片展示的版本必须来自真实安装产物，不要用占位词代替。
- 对 Node 包版本展示，优先使用解析后的包元数据，而不是在检测函数里写死静态文案。
