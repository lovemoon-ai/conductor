# Windows chat-web broker 命名管道转义

## 现象

Windows 地址模板产生的字符串缺少必要的反斜杠，无法作为标准命名管道地址。
macOS/Linux 测试走 Unix socket 分支，无法暴露这个问题。

## 根因

普通 JavaScript 模板字面量消耗了路径里的反斜杠；源码看似是 Windows 路径，
实际求值后的字符已经改变。没有对 Windows 分支的完整结果作断言。

## 修复

使用 String.raw 保留命名管道前缀与分隔符。新增测试模拟 process.platform
为 win32，以独立的字符码构造预期前缀，并校验完整地址和 profile 哈希。
测试结束恢复 platform 和 CHAT_WEB_HOME。

## 防止复发

对平台相关地址测试最终字符串，不只检查源码、子串或正则的大致形状。
预期值通过独立方式构造，避免复制实现里的转义错误。该测试可在 macOS/Linux
运行；它验证字符串格式，不代表 Windows 上的真实管道连接已验收。
