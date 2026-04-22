# Symptom

`conductor serve-ai` 在请求 `response_format.json_schema` 时，真实 backend 会返回 `502 invalid_backend_json`，尤其出现在：

- Claude text / image structured output
- Codex image structured output
- Kimi image structured output

用户侧表现是 OpenAI-compatible 接口请求失败，即使底层模型实际上已经产出了可用的结构化结果。

# Root Cause

问题分成两类：

1. Claude provider 读取错了 structured output 结果字段  
   Claude Agent SDK 的真实结构化结果在 `result.structured_output`，但实现只读了 `result.result` / assistant text。

2. `serve-ai` 对 backend 输出做了过于严格的裸 `JSON.parse(text)`  
   真实 backend 可能返回：
   - JSON 外再包一层说明文本
   - fenced JSON
   - metadata 里已有结构化对象，但 `text` 不是纯 JSON

# Fix

- Claude provider 在请求带 `jsonSchema` 时优先读取 `structured_output`，并将其作为 JSON 文本返回
- `serve-ai` 增加 structured output 归一化逻辑：
  - 优先读取 backend metadata 里的 structured output
  - 支持 fenced JSON
  - 支持从包裹文本中提取第一个完整 JSON 值

# How To Avoid Next Time

- 接第三方/CLI backend 的 structured output 时，不要假设“最终文本一定是纯 JSON”
- 先区分三层语义：
  - transport output
  - assistant text
  - native structured output field
- 对真实 backend 做 live e2e，不要只靠 fake fixture
