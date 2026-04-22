# Symptom

用户用：

```bash
conductor serve-ai --backend kimi
```

启动服务后，再运行 `scripts/test-ai-serve.sh`，日志里仍然显示请求落到了 `codex`。

# Root Cause

测试脚本把请求体里的 `model` 默认写死成了 `codex`。  
`serve-ai` 的选择逻辑是：

- 请求体里有 `model` 时，优先使用请求里的 `model`
- 只有请求体不带 `model` 时，才回退到服务启动时的默认 backend

所以脚本实际上覆盖掉了 `conductor serve-ai --backend kimi`。

# Fix

- 将 `scripts/test-ai-serve.sh` 改成默认不传 `model`
- 只有显式设置 `CONDUCTOR_SERVE_AI_MODEL` 时，脚本才会把 `model` 填进请求

# How To Avoid Next Time

- 给“用于验证服务默认行为”的测试脚本加可选字段时，不要再给这些字段设会改变行为的默认值
- 对“服务默认配置”和“请求显式参数”的优先级，脚本里要保持和服务端语义一致
