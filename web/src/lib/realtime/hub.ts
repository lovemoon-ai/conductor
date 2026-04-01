type Connection = {
  id: string;
  kind: "app" | "agent";
  userId: string;
  projectIds: string[];
  host?: string;
  supportedBackends?: string[];
  capabilities?: string[];
  version?: string;
  send: (payload: unknown) => void;
  close: () => void;
  lastHeartbeat?: number;
};

type StopAckWaiter = {
  resolve: (acked: boolean | null) => void;
  timeout: NodeJS.Timeout;
};

type FinalStatusWaiter = {
  resolve: (status: string | null) => void;
  timeout: NodeJS.Timeout;
};

export type AgentLogEntry = {
  timestamp: string | null;
  level: string;
  message: string;
};

export type AgentLogCollectionResult = {
  request_id: string;
  task_id: string;
  daemon_host: string | null;
  project_path: string | null;
  log_path: string | null;
  logs: AgentLogEntry[];
  truncated: boolean;
  error: string | null;
  collected_at: string;
};

export type TerminalLatencySample = {
  task_id: string;
  client_input_seq?: number;
  client_sent_at?: string;
  server_received_at?: string;
  daemon_received_at?: string;
  first_output_at?: string;
  daemon_input_to_first_output_ms?: number;
  recorded_at: string;
};

type AgentLogWaiter = {
  resolve: (result: AgentLogCollectionResult | null) => void;
  timeout: NodeJS.Timeout;
};

type TerminalDetachResult = {
  detachedTaskIds: string[];
  releasedWriterTaskIds: string[];
};

const isTerminalTaskStatus = (status: string): boolean =>
  status === "completed" || status === "killed";

// Use global to persist across Next.js hot reloads in development
const globalForHub = globalThis as unknown as { realtimeHub?: RealtimeHub };

export class RealtimeHub {
  private connections = new Map<string, Connection>();
  private taskToAgent = new Map<string, string>();
  private agentDisconnectAt = new Map<string, number>();
  private stopAckWaiters = new Map<string, StopAckWaiter>();
  private finalStatusWaiters = new Map<string, Set<FinalStatusWaiter>>();
  private agentLogWaiters = new Map<string, AgentLogWaiter>();
  private terminalSubscriptions = new Map<string, Set<string>>();
  private appTerminalTasks = new Map<string, Set<string>>();
  private terminalWriters = new Map<string, string>();
  private terminalLatencyByTask = new Map<string, TerminalLatencySample>();

  private agentKey(userId: string, host: string): string {
    return `${userId}:${host}`;
  }

  register(conn: Connection) {
    conn.lastHeartbeat = Date.now();
    if (conn.kind === "agent" && conn.host) {
      this.agentDisconnectAt.delete(this.agentKey(conn.userId, conn.host));
    }
    this.connections.set(conn.id, conn);
  }

  unregister(id: string) {
    const conn = this.connections.get(id);
    this.connections.delete(id);
    const appDetachResult =
      conn?.kind === "app"
        ? this.detachTerminal(id)
        : { detachedTaskIds: [] as string[], releasedWriterTaskIds: [] as string[] };

    // Remove stale task bindings when an agent disconnects.
    if (conn?.kind === "agent" && conn.host) {
      this.agentDisconnectAt.set(this.agentKey(conn.userId, conn.host), Date.now());
      for (const [taskId, agentHost] of this.taskToAgent.entries()) {
        if (agentHost === conn.host) {
          this.taskToAgent.delete(taskId);
        }
      }
    }

    return {
      connection: conn ?? null,
      ...appDetachResult,
    };
  }

  heartbeat(id: string) {
    const conn = this.connections.get(id);
    if (conn) conn.lastHeartbeat = Date.now();
  }

  updateProjectIds(id: string, projectIds: string[]) {
    const conn = this.connections.get(id);
    if (conn) conn.projectIds = projectIds;
  }

  hasAgentHost(host: string, userId: string): boolean {
    for (const conn of this.connections.values()) {
      if (conn.kind === "agent" && conn.host === host && conn.userId === userId) {
        return true;
      }
    }
    return false;
  }

  takeOverAgentHost(host: string, userId: string): number {
    const matchingIds: string[] = [];
    for (const conn of this.connections.values()) {
      if (conn.kind === "agent" && conn.host === host && conn.userId === userId) {
        matchingIds.push(conn.id);
      }
    }

    for (const connectionId of matchingIds) {
      const conn = this.connections.get(connectionId);
      this.connections.delete(connectionId);
      try {
        conn?.close();
      } catch {
        // best effort
      }
    }

    return matchingIds.length;
  }

  getAgentDisconnectAt(host: string, userId: string): number | null {
    return this.agentDisconnectAt.get(this.agentKey(userId, host)) ?? null;
  }

  getAgentsForUser(userId: string): { id: string; host: string; supportedBackends: string[]; capabilities: string[]; version?: string }[] {
    const agents: { id: string; host: string; supportedBackends: string[]; capabilities: string[]; version?: string }[] = [];
    for (const conn of this.connections.values()) {
      if (conn.kind === "agent" && conn.userId === userId && conn.host) {
        agents.push({
          id: conn.id,
          host: conn.host,
          supportedBackends: conn.supportedBackends || [],
          capabilities: conn.capabilities || [],
          version: conn.version,
        });
      }
    }
    return agents;
  }

  bindTaskToAgent(taskId: string, agentHost: string) {
    this.taskToAgent.set(taskId, agentHost);
  }

  getTaskAgentHost(taskId: string): string | null {
    return this.taskToAgent.get(taskId) ?? null;
  }

  unbindTask(taskId: string) {
    this.taskToAgent.delete(taskId);
  }

  attachTerminal(connectionId: string, taskId: string): boolean {
    const conn = this.connections.get(connectionId);
    if (!conn || conn.kind !== "app") {
      return false;
    }

    const taskSubscribers = this.terminalSubscriptions.get(taskId) ?? new Set<string>();
    taskSubscribers.add(connectionId);
    this.terminalSubscriptions.set(taskId, taskSubscribers);

    const attachedTasks = this.appTerminalTasks.get(connectionId) ?? new Set<string>();
    attachedTasks.add(taskId);
    this.appTerminalTasks.set(connectionId, attachedTasks);
    return true;
  }

  detachTerminal(connectionId: string, taskId?: string): TerminalDetachResult {
    const attachedTasks = this.appTerminalTasks.get(connectionId);
    if (!attachedTasks || attachedTasks.size === 0) {
      return {
        detachedTaskIds: [] as string[],
        releasedWriterTaskIds: [] as string[],
      };
    }

    const taskIds = taskId ? [taskId] : [...attachedTasks];
    const releasedWriterTaskIds: string[] = [];
    for (const currentTaskId of taskIds) {
      const subscribers = this.terminalSubscriptions.get(currentTaskId);
      if (subscribers) {
        subscribers.delete(connectionId);
        if (subscribers.size === 0) {
          this.terminalSubscriptions.delete(currentTaskId);
        }
      }
      if (this.terminalWriters.get(currentTaskId) === connectionId) {
        this.terminalWriters.delete(currentTaskId);
        releasedWriterTaskIds.push(currentTaskId);
      }
      attachedTasks.delete(currentTaskId);
    }

    if (attachedTasks.size === 0) {
      this.appTerminalTasks.delete(connectionId);
    } else {
      this.appTerminalTasks.set(connectionId, attachedTasks);
    }

    return {
      detachedTaskIds: taskIds,
      releasedWriterTaskIds,
    };
  }

  isTerminalAttached(connectionId: string, taskId: string): boolean {
    return this.terminalSubscriptions.get(taskId)?.has(connectionId) ?? false;
  }

  getAttachedTerminalTaskIds(connectionId: string): string[] {
    return [...(this.appTerminalTasks.get(connectionId) ?? [])];
  }

  getTerminalSubscriberIds(taskId: string): string[] {
    return [...(this.terminalSubscriptions.get(taskId) ?? [])];
  }

  getTerminalViewerCount(taskId: string): number {
    return this.terminalSubscriptions.get(taskId)?.size ?? 0;
  }

  getTerminalWriter(taskId: string): string | null {
    const connectionId = this.terminalWriters.get(taskId);
    if (!connectionId) {
      return null;
    }
    return this.connections.has(connectionId) ? connectionId : null;
  }

  requestTerminalWriter(taskId: string, connectionId: string, options: { force?: boolean } = {}) {
    if (!this.isTerminalAttached(connectionId, taskId)) {
      return { granted: false, writerConnectionId: this.getTerminalWriter(taskId) };
    }

    const currentWriter = this.getTerminalWriter(taskId);
    if (!currentWriter || currentWriter === connectionId || options.force) {
      this.terminalWriters.set(taskId, connectionId);
      return { granted: true, writerConnectionId: connectionId };
    }

    return { granted: false, writerConnectionId: currentWriter };
  }

  releaseTerminalWriter(taskId: string, connectionId: string): boolean {
    if (this.terminalWriters.get(taskId) !== connectionId) {
      return false;
    }
    this.terminalWriters.delete(taskId);
    return true;
  }

  isTerminalWriter(taskId: string, connectionId: string): boolean {
    return this.terminalWriters.get(taskId) === connectionId;
  }

  recordTerminalLatencySample(taskId: string, sample: Omit<TerminalLatencySample, "task_id" | "recorded_at">) {
    this.terminalLatencyByTask.set(taskId, {
      task_id: taskId,
      ...sample,
      recorded_at: new Date().toISOString(),
    });
    while (this.terminalLatencyByTask.size > 1000) {
      const oldestKey = this.terminalLatencyByTask.keys().next();
      if (oldestKey.done) {
        break;
      }
      this.terminalLatencyByTask.delete(oldestKey.value);
    }
  }

  getTerminalLatencySample(taskId: string): TerminalLatencySample | null {
    return this.terminalLatencyByTask.get(taskId) ?? null;
  }

  sendToConnection(connectionId: string, payload: unknown): boolean {
    const conn = this.connections.get(connectionId);
    if (!conn) {
      return false;
    }
    conn.send(payload);
    return true;
  }

  broadcastTerminal(userId: string, taskId: string, payload: unknown) {
    const subscribers = this.terminalSubscriptions.get(taskId);
    if (!subscribers || subscribers.size === 0) {
      return 0;
    }

    let sentCount = 0;
    for (const connectionId of subscribers) {
      const conn = this.connections.get(connectionId);
      if (!conn || conn.kind !== "app" || conn.userId !== userId) {
        continue;
      }
      conn.send(payload);
      sentCount += 1;
    }
    return sentCount;
  }

  broadcast(userId: string, projectId: string, payload: unknown) {
    let sentCount = 0;
    for (const conn of this.connections.values()) {
      if (conn.userId !== userId) continue;
      if (conn.projectIds.includes("*") || conn.projectIds.includes(projectId)) {
        conn.send(payload);
        sentCount++;
      }
    }
    console.log(`[realtimeHub] broadcast: userId=${userId}, projectId=${projectId}, sentTo=${sentCount} connections`);
  }

  sendToAgent(taskId: string, payload: unknown): boolean {
    const agentHost = this.taskToAgent.get(taskId);
    if (!agentHost) return false;
    const conn = this.findAgentConnectionByHost(agentHost);
    if (!conn) return false;
    conn.send(payload);
    return true;
  }

  sendToAgentHost(userId: string, agentHost: string, payload: unknown): boolean {
    const conn = this.findAgentConnectionByHost(agentHost, userId);
    if (!conn) return false;
    conn.send(payload);
    return true;
  }

  waitForTaskStopAck(taskId: string, requestId: string, timeoutMs: number): Promise<boolean | null> {
    const key = `${taskId}:${requestId}`;
    return new Promise<boolean | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.stopAckWaiters.delete(key);
        resolve(null);
      }, timeoutMs);
      this.stopAckWaiters.set(key, { resolve, timeout });
    });
  }

  acknowledgeTaskStop(taskId: string, requestId: string, accepted = true) {
    const key = `${taskId}:${requestId}`;
    const waiter = this.stopAckWaiters.get(key);
    if (!waiter) return;

    clearTimeout(waiter.timeout);
    this.stopAckWaiters.delete(key);
    waiter.resolve(Boolean(accepted));
  }

  waitForTaskFinalStatus(taskId: string, timeoutMs: number): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        const waiters = this.finalStatusWaiters.get(taskId);
        if (waiters) {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            this.finalStatusWaiters.delete(taskId);
          }
        }
        resolve(null);
      }, timeoutMs);

      const waiter: FinalStatusWaiter = { resolve, timeout };
      const existing = this.finalStatusWaiters.get(taskId);
      if (existing) {
        existing.add(waiter);
      } else {
        this.finalStatusWaiters.set(taskId, new Set([waiter]));
      }
    });
  }

  notifyTaskStatus(taskId: string, status: string) {
    if (!isTerminalTaskStatus(status)) return;

    // Backward-compatible fallback: terminal status implies stop request was accepted.
    for (const [key, waiter] of this.stopAckWaiters.entries()) {
      if (!key.startsWith(`${taskId}:`)) continue;
      clearTimeout(waiter.timeout);
      waiter.resolve(true);
      this.stopAckWaiters.delete(key);
    }

    const waiters = this.finalStatusWaiters.get(taskId);
    if (!waiters) return;

    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(status);
    }
    this.finalStatusWaiters.delete(taskId);
  }

  waitForAgentLogCollection(requestId: string, timeoutMs: number): Promise<AgentLogCollectionResult | null> {
    return new Promise<AgentLogCollectionResult | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.agentLogWaiters.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.agentLogWaiters.set(requestId, { resolve, timeout });
    });
  }

  resolveAgentLogCollection(result: AgentLogCollectionResult) {
    const waiter = this.agentLogWaiters.get(result.request_id);
    if (!waiter) return;

    clearTimeout(waiter.timeout);
    this.agentLogWaiters.delete(result.request_id);
    waiter.resolve(result);
  }

  cancelAgentLogCollection(requestId: string) {
    const waiter = this.agentLogWaiters.get(requestId);
    if (!waiter) return;

    clearTimeout(waiter.timeout);
    this.agentLogWaiters.delete(requestId);
    waiter.resolve(null);
  }

  private findAgentConnectionByHost(host: string, userId?: string): Connection | null {
    for (const conn of this.connections.values()) {
      if (conn.kind !== "agent") continue;
      if (conn.host !== host) continue;
      if (userId && conn.userId !== userId) continue;
      return conn;
    }
    return null;
  }

  /**
   * Restore task-to-agent bindings from database on server startup.
   * This prevents tasks from getting stuck in 'init' state after server restart.
   */
  async restoreTaskBindingsFromDb(
    fetchActiveTasks: () => Promise<Array<{ id: string; agentHost: string | null }>>,
  ): Promise<number> {
    try {
      const tasks = await fetchActiveTasks();
      let restoredCount = 0;
      for (const task of tasks) {
        if (task.agentHost) {
          this.taskToAgent.set(task.id, task.agentHost);
          restoredCount++;
        }
      }
      console.log(`[realtimeHub] Restored ${restoredCount} task bindings from database`);
      return restoredCount;
    } catch (error) {
      console.error("[realtimeHub] Failed to restore task bindings:", error);
      return 0;
    }
  }
}

export const realtimeHub = globalForHub.realtimeHub ?? new RealtimeHub();
globalForHub.realtimeHub = realtimeHub;
