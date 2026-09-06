# conductor remote 使用说明

`conductor remote` 是「在另一台 daemon 主机上做事」的统一入口，两个动词：

```bash
conductor remote exec <...>   # 跑一条命令，拿 stdout/stderr/退出码
conductor remote cp   <...>   # 传一个文件，双向
```

设计文档：`claw/rfc/0034-feature-remote-exec.md`（exec）、
`claw/rfc/0037-feature-remote-file-transfer.md`（cp）。

前提：目标 daemon 必须**在线**（`conductor daemon` 跑着并连上了同一个后端），
且属于**同一个账号**。daemon 之间没有互相寻址和信任关系，所有流量都经过后端中转。

## 1. conductor remote exec

```bash
conductor remote exec --target <daemon> [options] <command> [args...]
conductor remote exec --target <daemon> [options] -- <command> [args...]
```

| flag | 作用 |
|---|---|
| `-t, --target <daemon>` | 目标 daemon 名（必填）。就是 `conductor config` 里的 `daemon_name` |
| `-w, --workspace <path>` | 目标机上的工作目录，默认是目标机的 home |
| `--timeout <dur>` | 总时限，`30s` / `2m` / `500ms` / 裸数字（秒）。默认 60s |
| `-e, --env KEY=VALUE` | 额外环境变量，可重复 |
| `--json` | 打印原始 run 结果 JSON |
| `--kill-on-timeout` | 到点后停掉远端命令。**默认不停**，命令会在目标机上继续跑 |
| `--config-file <p>` | 指定用哪个 config.yaml 鉴权 |

### 不经过 shell

命令是以 argv 形式发过去、在目标机上 `spawn` 的，**没有 shell**。
所以管道、通配符、重定向都不会被解释：

```bash
# 不行：| 会被当成 ls 的一个字面参数
conductor remote exec -t ubuntu -- ls | wc -l

# 要显式要一个 shell
conductor remote exec -t ubuntu -- bash -lc "ls | wc -l"
```

好处是本地的引号不会被远端二次解析，`git log --oneline -5` 这类带 flag 的命令能原样透传。

### 退出码follow ssh

远端命令自己的退出码**原样透传**（0-254），`255` 专门留给 CLI 自身的失败
（用法错误、daemon 不在线、网络错误、超时后仍在运行）。

所以 `grep` 没匹配到（1）和网络故障是能区分的 —— 不要把 255 当成"远端返回了 255"。

### 输出上限

stdout/stderr 各自只保留**尾部 64 000 字符**，超了会带 `truncated` 标记。
要完整输出就先重定向到文件再 `remote cp` 取回。

## 2. conductor remote cp

```bash
conductor remote cp [options] <src> <dst>
```

`<src>` 和 `<dst>` 中**必须恰好有一个**写成 `<daemon>:<path>` 的形式，方向由它决定：

```bash
# 上传
conductor remote cp ./build.tar.gz ubuntu:/srv/app/build.tar.gz

# 下载
conductor remote cp ubuntu:/var/log/conductor.log ./conductor.log

# 用 --target 时远端侧可以省略 daemon 名
conductor remote cp -t ubuntu ./a.bin :/tmp/a.bin
```

| flag | 作用 |
|---|---|
| `-r, --recursive` | 递归传目录 |
| `-t, --target <daemon>` | 路径写成 `:<path>` 时用哪个 daemon |
| `--timeout <dur>` | 总时限，默认 **30m**（**也约束远端 tar 步骤**） |
| `--json` | 打印原始 transfer 结果 JSON |
| `--config-file <p>` | 指定用哪个 config.yaml 鉴权 |

### 路径解析规则

- 以 `/`、`.`、`~` 开头的一律当**本地路径**，即使里面有冒号。
  所以本地文件 `a:b` 要写成 `./a:b`。
- 目标是一个**已存在的目录**时，沿用 scp 语义，自动拼上源文件名。
- 两侧都是远端 → 报错（不支持 daemon 到 daemon）。
- 两侧都是本地 → 报错（那是 `cp` 的活）。

### 完整性保证

- 内容用 **SHA-256 端到端校验**，对不上直接失败。
- 落盘一律先写 `.part` 再 `rename`，**中断不会留下半个文件**，也不会把已有文件截断成半截。
- 文件权限位（`mode & 0o777`）会一起带过去。

### 递归传目录（`-r`）

```bash
conductor remote cp -r ./dist ubuntu:/srv/app        # → /srv/app/dist
conductor remote cp -r ubuntu:/srv/app/logs ./logs   # → ./logs
```

目标语义与 scp 一致：

- 目标**已存在且是目录** → 源目录放进去，保留自己的名字（`/srv/app/dist`）
- 目标**不存在** → 目标本身就成为这份拷贝（`./logs`）
- `-r` 用在普通文件上 → 就是普通拷贝，不报错（同 scp）

实现方式是 tar 包装：本地/远端打包 → 走单文件传输 → 另一侧解包 → 清理临时包。
**协议没有变**，线上永远只传一个文件。

因此：

- 权限位和软链接由 tar 保留，不需要额外协议
- 需要目标机有 `tar`，且**同时具备 `remote_exec` 能力**（打包/解包是通过它跑的）。
  如果 host 设了 `remote_exec: false`，`-r` 用不了，普通单文件 cp 仍然可用
- 受限的是**压缩后**的大小，不是原始大小
- 远端临时包默认放 `/tmp`，可用 `CONDUCTOR_REMOTE_TMP` 改
- 传输失败或成功，远端临时包都会被清掉

路径是以 **argv 位置参数**传给远端 `sh` 的，从不拼进脚本文本，
所以名字里带 `;` `$` 空格的目录只是名字难看，不会被执行。

**不支持的**：断点续传（失败要整个重来）、逐文件进度、增量同步（不是 rsync）。
超大目录建议还是自己 tar + 单文件 cp，这样能控制分卷。

### 分片与断点续传

传输按 **32 MiB 分片**走标准 `Content-Range`。这不只是限流，**分片本身就是续传机制**：

- 网络抖动只重传**一片**，不是整个文件
- 上行失败后从服务端已收到的 offset 继续（服务端在 409 里告诉你真实 offset）
- 下行失败后从本地 `.part` 的当前大小继续（`Range: bytes=N-`）
- 自动重试 4 次，退避 500ms → 1s → 2s → 4s
- 4xx（除 409）不重试 —— 重试 413 只是浪费时间

续传是**单次调用内自动完成**的，对你透明，不需要记 transferId、不需要加 flag。

大文件还会走**两阶段**：后端等 8 秒，没传完就先回一个「进行中」，CLI 转为轮询。
这是必须的 —— 阻塞式响应会被 nginx 在 60 秒掐断，1 GiB 根本不可能在里面传完。
跨调用续传（重新敲一遍命令接上上次）没做：协议原语已经具备，但 UX 面积大而场景罕见。

分片大小可用 `CONDUCTOR_REMOTE_CHUNK_BYTES` 调小（链路很差时有用）。

默认 `--timeout` 是 **30 分钟** —— 1 GiB 在 5 Mbit/s 上要 27 分钟左右，
而有了续传之后，让慢传输跑完比中途掐断更合理。超过 8 MB 的传输会在 stderr 打进度。

**校验时机很关键**：续传的下载会对**最终组装好的整个文件**重算 sha256，
不是流式累加 —— 流式 hash 只看得到最后一段，会给拼接错误的文件开绿灯。

### 大小限制

单文件默认上限 **1 GiB**。后端和 daemon **各自**读 `CONDUCTOR_REMOTE_FILE_MAX_BYTES`，
两边都要改才真正生效 —— 只改一边的话，另一边会先把传输拒掉。

`-r` 时这个限制作用在**压缩后的 tarball** 上。

服务端另有几道闸（这些是为了不把 Conductor 服务器写爆）：

| 闸 | 默认值 | 超出时 |
| --- | --- | --- |
| 全局暂存总量 | 8 GiB（`CONDUCTOR_REMOTE_FILE_TOTAL_BYTES`） | 507 |
| 每用户暂存总量 | 2 GiB | 507 |
| 每用户并发传输 | 4 | 429 |
| 磁盘可用空间余量 | 2 GiB | 507 |

创建传输时按**声明的大小**预留额度，而不是按已写入字节 —— 否则同时发起的多个
传输会各自通过检查，然后一起把磁盘撑爆。

## 3. 能力协商与关停开关

两个动词各有独立的 capability，daemon 在握手时上报：

| 动词 | capability | 关掉的方式 |
|---|---|---|
| `remote exec` | `remote_exec` | config.yaml 里 `remote_exec: false`，或 `CONDUCTOR_REMOTE_EXEC=0` |
| `remote cp` | `remote_file` | config.yaml 里 `remote_file: false`，或 `CONDUCTOR_REMOTE_FILE=0` |

两者故意分开，这样版本错配时能拿到一个干净的 **409**（附升级提示）而不是干等超时。

**注意**：这两个 capability 不是安全边界 —— 拿到 `remote_exec` 的人本来就能
`bash -lc 'base64 file'` 把文件读出来。它们的价值在于协商，以及让 host 能明确表态。

## 4. 常见报错

| 现象 | 原因 |
|---|---|
| `404 daemon not connected` | 目标 daemon 不在线，或名字拼错 |
| `409 daemon does not support ...` | daemon 版本太老，或 host 自己关掉了该 capability |
| `429 too many concurrent ...` | 同一账号并发太多（exec 8 个 / 传输 4 个），稍等重试 |
| `504` | daemon 收到了但没在时限内回话 |
| 退出码 255 且提示 `still running` | 命令还在目标机上跑。用 `--kill-on-timeout`，或调大 `--timeout` |
| `checksum mismatch` | 传输过程中内容损坏，本地不会留下文件，直接重试 |
| `is a directory; pass -r` | 传目录忘了加 `-r` |
| `-r` 报 `not a directory` | 远端那个路径不是目录 |
| `-r` 报 409 / `remote exec` 相关 | 目标机关掉了 `remote_exec`，打包/解包跑不了 |
| `507` | 服务端暂存空间到顶了（全局 / 每用户 / 磁盘余量），稍后再试 |
| `413` | 超过单文件 1 GiB 上限。`-r` 的话看压缩后大小 |
