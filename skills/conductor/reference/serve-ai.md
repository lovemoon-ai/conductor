# conductor serve-ai 使用说明

`conductor serve-ai` 会把 `modules/ai-sdk` 接入的本地 AI backend 包装成一个 OpenAI-compatible HTTP Server。

当前主要接口：

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

当前支持：

- 纯文本对话
- 当前轮图片输入
- `response_format.json_object`
- `response_format.json_schema`

当前不支持：

- `stream=true`
- OpenAI tools / function calling
- `n != 1`

## 1. 前置条件

需要满足这几件事：

1. 已安装 `conductor` CLI
2. 已安装并可直接运行对应 backend CLI，比如 `codex`、`claude`、`kimi`
3. 对应 backend 已在本机完成登录或鉴权
4. `allow_cli_list` 能解析这些 backend 的启动命令

## 2. 配置文件查找规则

`serve-ai` 会先找主配置文件：

- `~/.conductor/config.yaml`

如果主配置不存在，再找同目录下的专用配置：

- `~/.conductor/config-ai-serve.yaml`

也可以显式指定主配置路径：

```bash
conductor serve-ai --config-file ~/.conductor/config-dev.yaml
```

这时 fallback 路径会变成：

- `/abs/path/to/config-ai-serve.yaml`，也就是你传入的 `--config-file` 同目录下的 `config-ai-serve.yaml`

## 3. 初始化 serve-ai 配置

如果你还没有主配置，可以先执行：

```bash
conductor serve-ai init
```

它会创建：

```text
~/.conductor/config-ai-serve.yaml
```

注意：

- 只有当同目录下的主配置 `config.yaml` 不存在时，`config-ai-serve.yaml` 才会被 `serve-ai` 作为活动配置读取
- 如果 `config.yaml` 已存在，`serve-ai` 会优先使用 `config.yaml`
- 所以 `init` 更适合“没有主配置，但想单独跑 `serve-ai`”的场景，而不是覆盖已有主配置

也可以指定默认 backend / 端口：

```bash
conductor serve-ai init --backend kimi --port 9000
```

或者写到其他目录：

```bash
conductor serve-ai init --config-file /tmp/conductor-dev/config.yaml
```

这会创建：

```text
/tmp/conductor-dev/config-ai-serve.yaml
```

典型配置示例：

```yaml
serve_ai:
  host: 127.0.0.1
  port: 8787
  backend: codex
  # api_key: local-dev-key

allow_cli_list:
  codex: codex
  kimi: kimi
  claude: claude

# envs:
#   http_proxy: http://127.0.0.1:7890
#   https_proxy: http://127.0.0.1:7890
```

## 4. 如何启动服务

最简单的启动方式：

```bash
conductor serve-ai
```

显式指定默认 backend 和端口：

```bash
conductor serve-ai --backend codex --port 8787
```

显式要求 Bearer API Key：

```bash
conductor serve-ai --api-key local-dev-key
```

启动后会输出类似：

```text
OpenAI-compatible server listening at http://127.0.0.1:8787 (default model: codex)
Config source: serve-ai (/Users/you/.conductor/config-ai-serve.yaml)
```

### 启动脚本示例

如果你希望用 shell 脚本固定启动参数，可以这样写：

```bash
#!/usr/bin/env bash
set -euo pipefail

conductor serve-ai \
  --config-file ~/.conductor/config.yaml \
  --backend codex \
  --port 8787 \
  --api-key local-dev-key
```

## 5. 查看可用模型

```bash
curl http://127.0.0.1:8787/v1/models
```

如果启用了 API key：

```bash
curl http://127.0.0.1:8787/v1/models \
  -H 'Authorization: Bearer local-dev-key'
```

返回的 `id` 就是请求里可填的 `model`。

## 6. 纯文本调用

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local-dev-key' \
  -d '{
    "model": "codex",
    "messages": [
      { "role": "user", "content": "Say hi in one sentence." }
    ]
  }'
```

## 7. 图片调用

图片输入走 OpenAI 风格的多段 `content`。

支持：

- `data:` URL
- 远程 `http/https` 图片 URL

示例：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "Describe the image in one sentence." },
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/png;base64,<BASE64_IMAGE>"
            }
          }
        ]
      }
    ]
  }'
```

## 8. 如何设置 output schema

`serve-ai` 对外使用 OpenAI 风格的 `response_format`。

### 8.1 `json_object`

如果你只要求“返回一个合法 JSON object”，可以用：

```json
{
  "response_format": {
    "type": "json_object"
  }
}
```

示例：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "kimi",
    "messages": [
      { "role": "user", "content": "Return a JSON object with ok=true." }
    ],
    "response_format": {
      "type": "json_object"
    }
  }'
```

### 8.2 `json_schema`

如果你要求固定字段和严格结构，使用：

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "reply",
      "schema": {
        "type": "object",
        "properties": {
          "backend": { "type": "string" },
          "ok": { "type": "boolean" }
        },
        "required": ["backend", "ok"],
        "additionalProperties": false
      }
    }
  }
}
```

完整示例：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "codex",
    "messages": [
      { "role": "user", "content": "Return backend and ok=true." }
    ],
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "reply",
        "schema": {
          "type": "object",
          "properties": {
            "backend": { "type": "string", "enum": ["codex"] },
            "ok": { "type": "boolean" }
          },
          "required": ["backend", "ok"],
          "additionalProperties": false
        }
      }
    }
  }'
```

### 8.3 图片 + `json_schema`

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "Inspect the attached image and return backend and dominant_color."
          },
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/png;base64,<BASE64_IMAGE>"
            }
          }
        ]
      }
    ],
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "image_reply",
        "schema": {
          "type": "object",
          "properties": {
            "backend": { "type": "string", "enum": ["claude"] },
            "dominant_color": { "type": "string" }
          },
          "required": ["backend", "dominant_color"],
          "additionalProperties": false
        }
      }
    }
  }'
```

## 9. output schema 到 backend 的映射

上层统一用 OpenAI `response_format`，底层会按 backend 能力做适配：

- `codex`
  - structured output 时切到 `codex exec`
  - 原生使用 schema 文件约束输出
- `claude`
  - 使用 Claude Agent SDK 的原生 structured output
- `kimi`
  - structured output 时切到非 `--wire` 的 print 模式
  - CLI 的 `--output-format=stream-json` 只负责传输格式
  - `json_schema` 本身目前仍通过 prompt fallback 实现

所以：

- 如果你想要最严格的 schema 约束，优先使用 `codex` 或 `claude`
- `kimi` 可以用，但当前 schema 约束不如前两者原生

## 10. 常见问题

### 10.1 为什么 `model` 填的值和真正运行的 backend 不一定完全一样？

`serve-ai` 会先按 `allow_cli_list` 和 backend alias 做解析。通常建议直接使用：

- `codex`
- `claude`
- `kimi`

### 10.2 为什么返回 `invalid_backend_json`？

说明你请求了 `response_format`，但 backend 最终没有产出可解析的 JSON。

优先检查：

1. prompt 是否明确要求返回 JSON
2. backend 是否真的支持当前场景
3. schema 是否过于严格

### 10.3 为什么图片场景里历史图片没有保真？

当前真正传给 backend 的图片只处理“最后一轮消息里的图片”。历史轮次里的图片会降级成文本占位。

### 10.4 为什么 `stream=true` 不工作？

当前 `serve-ai` 只支持非流式 `chat/completions`，`stream=true` 会返回错误。
