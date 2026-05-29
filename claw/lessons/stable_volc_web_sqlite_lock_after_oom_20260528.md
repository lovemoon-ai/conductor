# Volc Web Service SQLite Lock After OOM

## Symptom

- 用户报告无法登录 Conductor Web（https://conductor-ai.top）。
- `/api/health` 返回 000（Connection refused），6152 端口无 Node 进程监听。
- 首次 restart 后 health 恢复 200，但用户仍无法登录。
- 日志中持续出现 Prisma `P1008 Socket timeout`，所有数据库查询（`userToken.update`, `agentOutbox.update` 等）均超时失败。
- 服务器本地用 `sqlite3` 直接访问数据库文件报错：`database is locked (5)`。

## Root Cause

1. **Primary crash**: Node.js 进程因堆内存不足（`Allocation failed - JavaScript heap out of memory`）崩溃。
2. **Outbox backlog death spiral**: `agent_outbox` 表中积压了 515 条 `sent` 状态的消息（已投递但未 ack）和 1 条 `pending` 消息。`deliverAgentOutboxForHost` 的查询条件是 `status in ["pending", "sent"]`，因此每次 drain 都会把这 516 条消息全部捞出。
3. **Infinite retry loop**: 当对应 daemon 不在线时，`tryDeliverRow` → `markDeliveryDeferred` 将消息状态从 `sent` 改回 `pending`。下次 drain 又查到这些 `pending` 消息，再次尝试投递、再次失败、再次改回 `pending`。这形成了**无限高频 UPDATE 死循环**。
4. **SQLite write-lock saturation**: SQLite 是文件级数据库，持续的密集 UPDATE 导致写锁（RESERVED/EXCLUSIVE）被长时间持有。其他查询（包括登录认证）被阻塞，直到 Prisma `socket_timeout` 触发，表现为 `P1008 Socket timeout`。残留进程只是加速了锁死，但根本诱因是 outbox 积压死循环。即使彻底清理进程后单独重启，只要 516 条积压消息还在，服务启动后几十秒内就会再次锁死。

## Fix

1. **彻底清理进程**: 使用 `pkill -9 -f 'node.*server.ts'` 和 `pkill -9 -f 'tsx server.ts'` 杀掉所有相关 Node 进程，释放 SQLite 锁。
2. **清理 outbox 积压**: 直接删除长期未被 ack 的 `sent` 消息和已不存在的 dead host 的 `pending` 消息。这些是死循环的燃料。
   ```sql
   DELETE FROM agent_outbox WHERE status = 'sent' AND sent_at < datetime('now', '-1 hour');
   DELETE FROM agent_outbox WHERE status = 'pending' AND agent_host LIKE 'conductor-fire-unknown-host-%' AND created_at < datetime('now', '-1 hour');
   ```
3. **重建数据库**: `VACUUM` 回收空间并重建索引，消除长期高频 UPDATE 造成的碎片化。
4. **验证锁释放**: `sqlite3 /opt/conductor/conductor.db 'PRAGMA integrity_check;'` 返回 `ok`。
5. **冷启动**: 重新 `nohup npm --prefix web run start` 启动单一实例。
6. **验证**: health check `/api/health` 200，登录 API `/api/auth/request-code` 200，`agent_outbox` pending + sent = 0，无后续 Prisma timeout。

## How to Avoid Next Time

1. **Outbox 积压监控与自动清理**: `agent_outbox` 中的 `sent` 消息长期未被 ack 会触发死循环。应添加监控：当 `status='sent' AND sent_at < now() - interval '1 hour'` 的记录数超过阈值（如 100 条）时报警，并在 cron job 或 outbox-processor 中自动清理/归档这些僵尸消息。
2. **修复 outbox drain 死循环逻辑**: `deliverAgentOutboxForHost` 查询 `status in ["pending", "sent"]`，但 `sent` 消息在 daemon 不在线时会被 `markDeliveryDeferred` 改回 `pending`，导致无限重试。应修改策略：
   - 对 `sent` 消息增加 `maxRetryAt` 或 `ackDeadline` 字段，超过期限未 ack 的直接标记为 `failed` 或 `acked`，不再参与 drain。
   - 或者将 `sent` 与 `pending` 的 drain 逻辑分离，`sent` 状态仅在 daemon 在线时尝试重新投递（ack 超时补偿），不在线时不应回退为 `pending`。
3. **迁移到 PostgreSQL**: SQLite 是文件级数据库，不适合生产环境多 daemon 高频并发读写的场景。服务器上已运行 PostgreSQL，应尽早完成迁移（`web/.env.production.local` 中已有 PostgreSQL URL 注释）。迁移后 connection pool 和行级锁能根本解决此类并发瓶颈。
4. **使用 systemd/supervisor 管理进程**: 当前使用 `nohup &` 启动，崩溃后无自动恢复。建议用 `systemd` 管理，崩溃时自动清理并重启；同时限制单实例运行，防止残留进程竞争数据库锁。
5. **增加 Node 内存限制监控**: 当前 Node 进程内存增长到 4GB+ 后 OOM。应在启动参数增加 `--max-old-space-size=4096`，并通过日志监控内存趋势，提前预警。
6. **服务健康检查应包含 DB 连通性**: 当前的 `/api/health` 无法检测 SQLite 锁死状态。应在 health check 中加入一个轻量级写操作（如 `UPDATE _health_check SET last_check = now()`），确保数据库层真正可写后再标记服务健康。
