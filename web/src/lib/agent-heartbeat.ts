/**
 * Agent Heartbeat Manager
 * 监控Agent主机在线状态，处理离线检测
 */

import { db as prisma } from './db';

interface AgentConnection {
  agentHost: string;
  lastHeartbeat: number;
  connectionId: string;
  isOnline: boolean;
  userId: string;
}

const HEARTBEAT_INTERVAL = 30000; // 30秒心跳间隔
const OFFLINE_THRESHOLD = 90000;  // 90秒无心跳视为离线
const MAX_RETRY_BEFORE_OFFLINE = 3; // 离线前最大重试次数

class AgentHeartbeatManager {
  private connections = new Map<string, AgentConnection>();
  private monitoringInterval: NodeJS.Timeout | null = null;

  /**
   * 启动心跳监控
   */
  startMonitoring(): void {
    if (this.monitoringInterval) {
      return;
    }

    this.monitoringInterval = setInterval(() => {
      this.checkOfflineAgents();
    }, HEARTBEAT_INTERVAL);

    console.log('[AgentHeartbeat] Monitoring started');
  }

  /**
   * 停止心跳监控
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    console.log('[AgentHeartbeat] Monitoring stopped');
  }

  /**
   * 接收心跳
   */
  heartbeat(agentHost: string, connectionId: string, userId: string): void {
    const now = Date.now();
    const wasOffline = this.connections.get(agentHost)?.isOnline === false;

    this.connections.set(agentHost, {
      agentHost,
      lastHeartbeat: now,
      connectionId,
      isOnline: true,
      userId
    });

    if (wasOffline) {
      console.log(`[AgentHeartbeat] Agent back online: ${agentHost}`);
    }
  }

  /**
   * 断开连接
   */
  disconnect(connectionId: string): void {
    for (const [host, conn] of this.connections) {
      if (conn.connectionId === connectionId) {
        conn.isOnline = false;
        console.log(`[AgentHeartbeat] Agent disconnected: ${host}`);
        this.handleAgentOffline(host, conn.userId);
        break;
      }
    }
  }

  /**
   * 检测离线Agent
   */
  checkOfflineAgents(): void {
    const now = Date.now();

    for (const [host, conn] of this.connections) {
      if (conn.isOnline && now - conn.lastHeartbeat > OFFLINE_THRESHOLD) {
        conn.isOnline = false;
        console.log(`[AgentHeartbeat] Agent timeout offline: ${host}`);
        this.handleAgentOffline(host, conn.userId);
      }
    }
  }

  /**
   * 处理Agent离线
   */
  private async handleAgentOffline(agentHost: string, userId: string): Promise<void> {
    try {
      // 将超过重试次数的pending消息标记为失败
      const result = await prisma.agentOutbox.updateMany({
        where: {
          agentHost,
          userId,
          status: 'pending',
          attemptCount: { gte: MAX_RETRY_BEFORE_OFFLINE }
        },
        data: {
          status: 'failed',
          lastError: `Agent host offline: ${agentHost}`,
          updatedAt: new Date()
        }
      });

      if (result.count > 0) {
        console.log(`[AgentHeartbeat] Marked ${result.count} messages as failed for offline agent: ${agentHost}`);
      }
    } catch (error) {
      console.error('[AgentHeartbeat] Error handling offline agent:', error);
    }
  }

  /**
   * 获取Agent状态
   */
  getAgentStatus(agentHost: string): AgentConnection | undefined {
    return this.connections.get(agentHost);
  }

  /**
   * 获取所有在线Agent
   */
  getOnlineAgents(): AgentConnection[] {
    return Array.from(this.connections.values()).filter(conn => conn.isOnline);
  }

  /**
   * 检查Agent是否在线
   */
  isOnline(agentHost: string): boolean {
    return this.connections.get(agentHost)?.isOnline ?? false;
  }
}

// 单例导出
export const heartbeatManager = new AgentHeartbeatManager();
