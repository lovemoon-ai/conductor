# chat-web 活动 turn 中断后的会话恢复

## 现象

跨任务 broker 在活动 turn 被停止、超时或 provider 报错后，后续 runTurn 和
/clear 都报 BROKER_SESSION_CLOSED。SDK 仍显示 booted=true，客户端也未关闭，
但实际标签页已经被销毁，任务因此无法继续。首轮失败且没有 conversationId
时，/clear 还会被误判为空操作。

## 根因

把清理失败的浏览器页和结束逻辑会话合并成同一个 dispose 操作。只验证其他
任务可以继续，以及排队中的取消，遗漏同一 SDK 会话在活动失败后的后续行为。

## 修复

- 将连接/逻辑会话与标签页生命周期分开。活动失败只停止并关闭旧页，保留原
  provider conversationId 和成功 turn 计数；显式 close 才关闭逻辑会话。
- 下次用户操作在队列内创建新页，恢复原 URL、等待历史加载、验证登录和准确
  ID，然后只发送这次新消息。Kimi 还等待恢复页面生成状态稳定，必要时停止
  网站恢复的旧流。失败消息不会被自动重试。
- ID 未知、provider 不支持恢复或恢复后 ID 不匹配时，不静默新建空对话；
  返回 BROKER_RECOVERY_REQUIRED，要求用户通过 /clear/newChat 明确重置。
- SDK 记录是否尝试过发送，确保首次失败后 /clear 也实际执行。
- 超时后的迟到操作不能修改计数、覆盖新页或清理新页；迟到创建的页自行关闭。

## 防止复发

将真实 startTurnBroker、QueuedChatSession、AI SDK ChatWebSession 串联验证：
活动 stop -> follow-up、stop -> clear、timeout/provider error -> follow-up
和 clear、首轮未知 ID、缺失恢复能力、错误恢复 ID，以及恢复迟到/创建页迟到。
确认原上下文和 ID 保持、成功 turn 计数连续、旧提示词仅提交一次。使用浏览器
样本验证 Kimi/ChatGPT/Gemini 恢复等待历史且不会发送提示词，并覆盖 Kimi
历史出现后才恢复生成状态的加载时序。真实 Kimi 账号另做中断恢复验收。
