# 协议结束先于页面空闲导致紧接的下一轮失败

## 现象

Kimi 第一轮已经 completed，客户端立即发送下一轮时却收到 PROVIDER_BUSY。相同账号的另一条独立 chat 正常。

## 根因

协议 done 已到达，页面仍短暂显示 stop。worker 立即将 completed 交给父进程，FIFO 调度随即启动下一轮，撞上了网页尚未释放的输入状态。

## 修复

协议完成后仍等待本页面 stop 控件消失，再返回 completed。真实繁忙和不确定状态不自动点击发送或重复提交；其他 chat 独立调度。

## 防止复发

浏览器 fixture 在收到 done 后延迟 650 ms 才隐藏 stop，并立即提交下一轮；真实 Kimi、DeepSeek 连续多轮与四路并行都重新验证。
