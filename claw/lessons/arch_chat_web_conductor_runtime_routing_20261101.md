# 网页适配器存在不等于 Conductor 已接入

## 现象

chat-web 有 DeepSeek 适配器，但 AI SDK 的 provider 入口没有开放；隔离运行时只有显式 socket 接口，Conductor 默认调用仍走共享 profile 队列。

## 根因

底层适配器、AI SDK 路由、daemon 广告的别名和登录资料使用不同入口。单测只证明各层存在，未保证实际对话串联。

## 修复

提供 web-deepseek 别名，使 Kimi/DeepSeek 默认使用托管隔离运行时；加入 Conductor 登录入口、自动启动、受限认证快照与稳定恢复身份。共享队列保留给其他 provider 和显式兼容模式。

## 验证与预防

API 测试保留网页别名，CLI 测试验证别名与模型/DeepThink 参数，SDK 测试验证隔离及恢复；实际 Kimi 验证消息桥与子进程路径。真实 DeepSeek 仍需账号登录后完成本轮验收，不能用适配器注册代替该结果。
