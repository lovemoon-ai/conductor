# Kimi 新版协议导致回复完成后仍超时

## 现象

真实 Kimi 账号发送后网页已有完整回复，runtime 却返回 uncertain；初始流式事件还包含页面展示的思考文本。模拟旧版 SSE 的测试全部通过。

## 根因

当前 Kimi 使用 /apiv2/kimi.gateway.chat.v1.ChatService/Chat，Content-Type 为 application/connect+json。它以五字节二进制头分帧 JSON，不能整体先做 UTF-8 解码。旧适配只匹配 /api/chat/.../completion/stream，且 DOM 选择器同时覆盖思考和回答。网页读取 turn done 后可能主动 abort，等待 clone 的传输尾帧会误报中断；同步等待每次 IPC 还会拖慢 clone 的消费。

## 修复

匹配新旧端点，按原始字节解析 Connect envelope，只收集 block.text，支持 set/append；单条 message completed 不作为整轮终态，使用明确的 turn done，收到错误尾帧仍失败。已观察 done 后的 AbortError 可以收敛，未见 done 的截断流仍为 uncertain。异步发送有界捕获队列，DOM 排除思考容器，更新真实 stop 控件。

## 防止复发

浏览器回归覆盖 Connect、UTF-8 跨包、done 后主动 abort、缺失终态、显式错误及独立停止。真实账号验收不能由相同假设编写的模拟页面替代。Kimi 当前 headless 返回 401 的限制另记在 README，不宣称已解决。
