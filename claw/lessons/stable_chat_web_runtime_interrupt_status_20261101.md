# 运行时停止要保持 Conductor 的中断语义

## 现象

已确认停止的网页生成可能被消息桥归类为处理失败；启动过程中按停止，还可能在启动完成后提交消息。

## 根因

AI SDK 曾在标记本轮中断之前等待取消 RPC；运行时取消异常也只有通用 code，没有消息桥识别的 reason 和 turnStatus。

## 修复

先标记并触发本轮 AbortSignal，再等待运行时取消。SDK 传递 turn_cancelled 和 cancelled 状态，并在启动后检查已取消状态；停止前未提交的消息不发送。

## 验证与预防

测试覆盖取消、启动期间取消、另一 chat 继续工作。实际 Kimi 经 AI SDK IPC 和 Conductor BridgeRunner 得到 stopConfirmed=true，另一条对话完成，消息桥未报告处理失败。跨进程错误协议需保留宿主识别的状态字段。
