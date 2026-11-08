# Kimi 并行负载与 Moli 迁移评估

2026-10-30 的决定是继续使用 Chromium。Moli 1.1.20 在真实 Kimi 负载中减少了内存，但增量采集与完成确认尚未达到当前 SDK 的要求，空闲 CPU 也更高。它适合作为后续可选引擎，暂不替换第一版运行时。

两路 Kimi 已完成两轮真实并行生成。两个 DeepSeek profile 和独立登录 profile 均跳转到 sign_in，专用登录窗口等待期间未恢复认证，因此本轮没有有效的“两路 Kimi 加两路 DeepSeek”生成期测量。此前四路功能验收通过，说明能够并行；不能据此补出本轮四路资源数字。当前四路部署先按 **3–4 GiB 的内存预算**规划，这是工程预留值。

## 两路 Kimi 的实测消耗

环境为 macmini，Apple M4，16 GiB 内存，10 个逻辑核心，macOS 26.4，Node 22.18.0。Chromium 使用仓库现有 ChatRuntime 和两个独立 Node worker；Kimi 使用有窗口模式。Moli 为官方 1.1.20 arm64 release，每个 chat 一个进程和 profile，通过 raw CDP 连接。发布信息见 [Moli 1.1.20](https://github.com/lexmount/moli/releases/tag/v1.1.20)。

两种执行引擎使用相同的两个历史会话 URL，每轮分别请求输出 1 到 400，每行一个整数，每路回复均为 1491 个字符。每个引擎执行两轮，分开运行；会话历史随测试增长。两侧生成期间均每 100ms 读取 DOM。该负载测量长文本输出，不覆盖搜索、附件或长时间推理。

以下内存为进程树 footprint 合计的中位数。CPU 为阶段平均值，100% 表示占用一个逻辑核心；不是整台十核机器的 100%。

| 阶段 | Chromium 内存 | Moli 原型内存 | Chromium CPU | Moli 原型 CPU |
| --- | ---: | ---: | ---: | ---: |
| 第一次并行生成 | 1614 MiB | 622 MiB | 75.7% | 46.9% |
| 第二次并行生成 | 1656 MiB | 636 MiB | 82.2% | 48.1% |
| 回复结束后空闲 | 1176 MiB | 675 MiB | 6.9% | 29.8% |

生成阶段峰值分别为 Chromium 1710 MiB 和 Moli 715 MiB。进程树包含 Chromium 17 个存活进程，Moli 原型 3 个。两路恢复到可输入状态分别耗时约 2.6 秒和 4.1 秒；该结果不支持真实站点启动明显加速的判断。具体阶段、样本数与逐轮数据见 [测量结果](performance-2026-10-30.json)。

Moli 原型没有当前运行时的两个 Node worker，其控制器也更轻。若扣除 Moli 控制器，再加回实测 Chromium 控制器和 worker 的内存，生成阶段约为 **875–893 MiB，估算节省约 46%**；空闲约为 **924 MiB，估算节省约 21%**。这是相同宿主层的加法估算，尚未实现并测量 Moli SDK 后端。直接用原型总数宣传整个产品节省六成以上内存，会把宿主差异也算进去。

Moli 生成期 CPU 数字对应整段回复到达的行为，不能作为等价实时 SDK 的 CPU 降幅。两个 Moli 页面结束生成后仍消耗约 30% CPU，切换到空白页后降到约 1.2%；页面运行负载是主要来源，具体脚本或调度原因尚未确定。

## Kimi 增量输出的阻塞条件

未经修改的 Moli 完成了四次回复，但每次采集分支只收到一个整段正文。首段正文在发送后约 16–20 秒、协议完成时才到达。Chromium 四次回复的首段正文约为 5.5–9.9 秒，随后持续产生增量，父进程每次收到 83–96 次文本更新。两侧总完成时间都在约 16–21 秒，不能据此宣称 Moli 提升模型生成速度。

真实 Kimi 发出的请求使用 redirect: "error"，请求体为 Uint8Array。独立抓取显示，Moli 的 fetch 约 18.9 秒后才返回响应头和正文；Chromium 约 0.14 秒返回响应头，之后持续读到正文。

[本地复现脚本](stream-content-types.mjs) 使用同源 loopback HTTP 服务，立即发送响应头，每 300ms 发一段，共十段。它同时检查原始响应和 clone 的正文完整性：

| 请求条件 | Moli 1.1.20 | Chromium |
| --- | --- | --- |
| 四种 Content-Type，redirect follow | 每个 reader 分十段接收 | 每个 reader 分十段接收 |
| Connect 类型、二进制请求体、测试认证头、AbortSignal，redirect follow | 约 0.3 秒收到首段 | 约 0.3 秒收到首段 |
| 同样请求，仅改为 redirect error | 约 3 秒后整段到达 | 约 0.3 秒收到首段 |
| 同样请求，仅改为 redirect manual | 约 3 秒后整段到达 | 约 0.3 秒收到首段 |
| XMLHttpRequest SSE | 十次增量 progress | 十次增量 progress |

因此，Content-Type 和 clone 本身不足以解释真实差异；redirect 策略是已经单独复现的缓冲触发条件。对应版本的 [Fetch 客户端](https://github.com/lexmount/moli/blob/v1.1.20/moli-fetch/src/client.rs) 与 [页面请求客户端](https://github.com/lexmount/moli/blob/v1.1.20/moli-renderer-v8/src/network/request_client.rs) 中也存在非传输层自动重定向请求进入缓冲路径的分支。

只在诊断进程中临时把真实 Kimi 请求改为 follow 后，响应头约 0.84 秒到达，但现有采集分支仅收到 21 字节 heartbeat。网络事件记录请求约 17.8 秒完成、正文 106823 字节，采集分支在 120 秒内仍无完整回答和完成信号。这个试验说明简单改变请求选项还不足以接入 SDK；后续读取问题需要继续定位。诊断修改没有进入产品代码，也不作为通过验收的资源样本。一次诊断准备还出现 HTTP 401，同样已排除。

## 四路容量和迁移顺序

当前架构为每路一个独立 Node worker 和 Chromium profile，四路上限不会让同一 chat 同时提交两次。两路 Kimi 本次生成占用约 1.6 GiB；加上两个 DeepSeek 浏览器、两个 worker 和余量，四路先预留 3–4 GiB。该预算不是四路有效认证后的实测中位数或峰值，也不构成不断增长的会话历史的内存上限。DeepSeek 的生成 CPU、DeepThink 开关对四路负载的影响，以及 Moli 的真实 DeepSeek XHR 兼容性，均不能从 Kimi 数字推算。

Moli 的收益应以**整个 SDK 的内存下降**验收。当前两路 Kimi 给出的同宿主层估算为生成期约 46%、空闲约 21%；两路 DeepSeek 的增量仍待有效账号测量，不提供精确的四路节省比例。空白页或上游网页抓取 benchmark 的降幅不能替代此处的网页聊天负载。

优先保留 Chromium，并考虑空闲 worker 回收、按 profile 与会话 URL 恢复，以减少长期挂页的内存。Moli 接入需要先保持 redirect error 的行为并恢复完整流采集，再通过真实 DeepSeek 发送、DeepThink、取消和双会话隔离，最后使用相同 worker 层测量四路和长期空闲。在这些条件满足前，迁移收益不足以抵消回复完整性和状态确认的风险。

## 测量和复现方法

[macOS 采样器](measure-macos.py) 每 500ms 从外部采样测试控制器及其存活后代，合计 proc_pid_rusage 的 ri_phys_footprint 和 CPU 时间。它不统计其他应用或已脱离父进程的 crash reporter；footprint 合计也不等同于整机可用内存的变化。每阶段剔除前五个样本，阶段内报告内存中位数、P95、峰值和平均 CPU。新出现进程的首个 CPU 样本不追溯启动消耗，因此不报告启动 CPU。

本机 CPU 计数按 mach timebase 125/3 转换，独立一秒忙循环校准与 Python process_time 均约一秒。测试期间 swap 为零。数据是单台机器两轮测量，服务端排队、历史增长、缓存和垃圾回收会影响复测结果。

```bash
python3 claw/research/moli/measure-macos.py --calibrate
python3 claw/research/moli/measure-macos.py /private/path/stage.json /private/path/samples.jsonl
node claw/research/moli/stream-content-types.mjs moli /path/to/moli /private/path/moli.json
node claw/research/moli/stream-content-types.mjs chromium /path/to/chromium /private/path/chromium.json
```

stage.json 指定 roots 和 phase，结束时写入 done: true。流式复现仅访问本地 fixture，无需 chatbot 登录。结果 JSON 保存逐阶段资源摘要、回复长度和时序、请求选项及本地 fixture 时序，不保存 cookies、登录 token、用户聊天正文或账号 profile 路径。真实站点原始样本和专用测试资料保存在 macmini 的私有 benchmark 目录。
