# 网页聊天并发错误丢失站点原因

## 现象

真实 Kimi 和 DeepSeek 账号触发并发限制时，Conductor 聊天只显示 Provider returned an error 或 Connect error，无法区分账号限制与程序故障。

## 根因

流解析器检测到错误后将整个错误覆盖为固定文案，丢弃 Kimi Connect detail 的并发原因和 DeepSeek 的 parallel_chat_limit。worker 又将错误统一包装成 UNCERTAIN，无法保留错误类型。

## 修复

按已验证的站点错误字段识别并发拒绝，生成包含站点名称和等待提示的中文文案，并保留 PROVIDER_CONCURRENCY_LIMIT 类型。其他错误保留受长度限制的消息和简单错误码，不转发整个响应或账号元数据。明确的站点错误优先于随后的流中断，错误不能被后续完成帧覆盖。

Conductor 使用现有错误消息与状态通道展示文案。此次修改保持原来的 uncertain 与人工确认保护，不增加自动重试。

## 验证与预防

使用真实响应结构的脱敏 fixture 验证解析，并覆盖真实 Chromium worker、本地 RPC、AI SDK 子进程、BridgeRunner 错误消息及状态、消息历史 API 和聊天气泡。区分并发限制与普通 resource_exhausted，覆盖部分回复后报错、未知错误与长度限制，防止恢复固定文案或误把错误当作成功。
