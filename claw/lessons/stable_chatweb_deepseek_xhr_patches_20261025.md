# DeepSeek 网页回复已出现但运行时不结束

## 现象

真实 DeepSeek 网页能显示完整答案，runtime 却在超时后进入 uncertain。

## 根因

网页使用 XMLHttpRequest 接收 SSE，fetch 捕获器看不到流。当前协议用 response/fragments/-1/content 指向最后一个数组元素；fragment.id 并非数组下标。仅识别正数 id 的解码器会丢失增量。终态还可能出现在 response 的 BATCH 相对路径更新中。

## 修复

在原请求的 progress/load 上增量读取 XHR responseText，沿用请求端点、来源、POST 和 turn token 限定，不改写请求。分片按数组顺序保存，支持负数下标、无 p 的连续增量、追加分片和 BATCH 路径。只输出 RESPONSE 分片；quasi_status 不作为终态。适配当前没有 aria-label 的圆形停止按钮。

## 防止复发

浏览器 fixture 使用 XHR 而非 fetch，分片 id 故意不等于下标，使用负数路径和 BATCH 完成。真实账号验证双路独立记忆、取消及恢复。停止控件的 SVG 选择器仍需随网页变更维护。
