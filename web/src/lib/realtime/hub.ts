type Connection = {
  id: string;
  kind: "app" | "agent";
  userId: string;
  projectIds: string[];
  host?: string;
  supportedBackends?: string[];
  runtimeBackendMap?: Record<string, string>;
  /**
   * Optional per-backend runtime health advertised by the daemon
   * (backend -> "ready" | "unauthenticated" | "missing" | "error"). Absent on
   * daemons that do not advertise it, in which case the runtime preflight
   * fails open. Distinct from `supportedBackends`, which only says the backend
   * is configured, not that it can currently start a turn.
   */
  runtimeHealth?: Record<string, string>;
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

type AgentCommandAckWaiter = {
  resolve: (acked: boolean | null) => void;
  timeout: NodeJS.Timeout;
  expectedHosts: Set<string> | null;
  pendingHosts: Set<string> | null;
  expectedEventType: string | null;
  sawReject: boolean;
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

export type ProjectPathValidationResult = {
  request_id: string;
  daemon_host: string | null;
  workspace_path: string | null;
  repo_root: string | null;
  worktree_branch: string | null;
  last_commit: string | null;
  last_commit_at: string | null;
  git_remote_url: string | null;
  file_count: number | null;
  icon?: string | null;
  agents?: Array<{
    name: string;
    doc: string;
    description: string | null;
    backend: string | null;
  }> | null;
  error: string | null;
  error_code: string | null;
  validated_at: string;
};

export type ProjectAgentsResult = {
  request_id: string;
  daemon_host: string | null;
  workspace_path: string | null;
  agents: Array<{
    name: string;
    doc: string;
    description: string | null;
    backend: string | null;
  }>;
  error: string | null;
  error_code: string | null;
  resolved_at: string;
};

export type TaskWorktreeCleanupResult = {
  request_id: string;
  task_id: string;
  daemon_host: string | null;
  worktree_branch: string | null;
  removed_path: string | null;
  cleaned: boolean;
  error: string | null;
  cleaned_at: string;
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

type ProjectPathValidationWaiter = {
  resolve: (result: ProjectPathValidationResult | null) => void;
  timeout: NodeJS.Timeout;
};

type ProjectAgentsWaiter = {
  resolve: (result: ProjectAgentsResult | null) => void;
  timeout: NodeJS.Timeout;
};

type TaskWorktreeCleanupWaiter = {
  resolve: (result: TaskWorktreeCleanupResult | null) => void;
  timeout: NodeJS.Timeout;
};

export type AiManagerResponse = {
  request_id: string;
  action: string;
  result?: unknown;
  error?: string | null;
};

type AiManagerWaiter = {
  resolve: (result: AiManagerResponse | null) => void;
  timeout: NodeJS.Timeout;
  /** Caller that registered this waiter; resolution is rejected when the
   *  responding socket does not match. Defends against cross-user collisions
   *  on a guessed request_id. */
  expectedUserId: string;
  expectedAgentHost: string;
};

export type CustomCommandsResponse = {
  request_id: string;
  action: string;
  result?: unknown;
  error?: string | null;
};

type CustomCommandsWaiter = {
  resolve: (result: CustomCommandsResponse | null) => void;
  timeout: NodeJS.Timeout;
  expectedUserId: string;
  expectedAgentHost: string;
};

export type RemoteExecResponse = {
  request_id: string;
  action: string;
  result?: unknown;
  error?: string | null;
};

type RemoteExecWaiter = {
  resolve: (result: RemoteExecResponse | null) => void;
  timeout: NodeJS.Timeout;
  expectedUserId: string;
  expectedAgentHost: string;
};

/**
 * The shape shared by every request/response waiter that is addressed to one
 * specific daemon, so `failWaitersForAgent` can sweep them uniformly.
 */
type HostScopedWaiter = {
  resolve: (result: null) => void;
  timeout: NodeJS.Timeout;
  expectedUserId: string;
  expectedAgentHost: string;
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
  private agentCommandAckWaiters = new Map<string, AgentCommandAckWaiter>();
  private finalStatusWaiters = new Map<string, Set<FinalStatusWaiter>>();
  private agentLogWaiters = new Map<string, AgentLogWaiter>();
  private projectPathValidationWaiters = new Map<string, ProjectPathValidationWaiter>();
  private projectAgentsWaiters = new Map<string, ProjectAgentsWaiter>();
  private taskWorktreeCleanupWaiters = new Map<string, TaskWorktreeCleanupWaiter>();
  private aiManagerWaiters = new Map<string, AiManagerWaiter>();
  private customCommandsWaiters = new Map<string, CustomCommandsWaiter>();
  private remoteExecWaiters = new Map<string, RemoteExecWaiter>();
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
      // A request/response waiter addressed to this daemon can never be
      // answered now, so resolve it immediately instead of pinning an open
      // HTTP request until its timeout fires.
      this.failWaitersForAgent(conn.userId, conn.host);
    }

    return {
      connection: conn ?? null,
      ...appDetachResult,
    };
  }

  /**
   * Resolve every pending daemon RPC waiter addressed to this user+host with
   * `null` (the same value a timeout produces), so callers fail fast on
   * disconnect. Only fires when no other connection still serves that host, so
   * a reconnect racing the old socket's close does not cancel live requests.
   */
  private failWaitersForAgent(userId: string, host: string) {
    if (this.findAgentConnectionByHost(host, userId)) return;

    const asHostScoped = (waiters: Map<string, HostScopedWaiter>) => waiters;
    const maps = [
      asHostScoped(this.remoteExecWaiters),
      asHostScoped(this.customCommandsWaiters),
      asHostScoped(this.aiManagerWaiters),
    ];
    for (const waiters of maps) {
      for (const [requestId, waiter] of waiters.entries()) {
        if (waiter.expectedUserId !== userId || waiter.expectedAgentHost !== host) continue;
        clearTimeout(waiter.timeout);
        waiters.delete(requestId);
        waiter.resolve(null);
      }
    }
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

  getAgentsForUser(userId: string): {
    id: string;
    host: string;
    supportedBackends: string[];
    runtimeBackendMap?: Record<string, string>;
    runtimeHealth?: Record<string, string>;
    capabilities: string[];
    version?: string;
  }[] {
    const agents: {
      id: string;
      host: string;
      supportedBackends: string[];
      runtimeBackendMap?: Record<string, string>;
      runtimeHealth?: Record<string, string>;
      capabilities: string[];
      version?: string;
    }[] = [];
    for (const conn of this.connections.values()) {
      if (conn.kind === "agent" && conn.userId === userId && conn.host) {
        agents.push({
          id: conn.id,
          host: conn.host,
          supportedBackends: conn.supportedBackends || [],
          ...(conn.runtimeBackendMap && Object.keys(conn.runtimeBackendMap).length > 0
            ? { runtimeBackendMap: conn.runtimeBackendMap }
            : {}),
          ...(conn.runtimeHealth && Object.keys(conn.runtimeHealth).length > 0
            ? { runtimeHealth: conn.runtimeHealth }
            : {}),
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

  broadcastToApps(userId: string, payload: unknown, projectId?: string) {
    let sentCount = 0;
    for (const conn of this.connections.values()) {
      if (conn.kind !== "app" || conn.userId !== userId) {
        continue;
      }
      const projectIdSet = new Set(conn.projectIds);
      if (projectId && !projectIdSet.has("*") && !projectIdSet.has(projectId)) {
        continue;
      }
      conn.send(payload);
      sentCount++;
    }
    return sentCount;
  }

  broadcast(userId: string, projectId: string, payload: unknown) {
    let sentCount = 0;
    for (const conn of this.connections.values()) {
      if (conn.userId !== userId) continue;
      const projectIdSet = new Set(conn.projectIds);
      if (projectIdSet.has("*") || projectIdSet.has(projectId)) {
        conn.send(payload);
        sentCount++;
      }
    }
    console.log(`[realtimeHub] broadcast: userId=${userId}, projectId=${projectId}, sentTo=${sentCount} connections`);
  }

  broadcastToUser(userId: string, payload: unknown) {
    let sentCount = 0;
    for (const conn of this.connections.values()) {
      if (conn.kind !== "app" || conn.userId !== userId) continue;
      conn.send(payload);
      sentCount++;
    }
    return sentCount;
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
    const envelopePayload = payload && typeof payload === "object"
      && "payload" in payload && (payload as { payload?: unknown }).payload
      && typeof (payload as { payload?: unknown }).payload === "object"
      ? (payload as { payload: Record<string, unknown> }).payload
      : null;
    const required = Array.isArray(envelopePayload?.required_capabilities)
      ? envelopePayload.required_capabilities.filter((value): value is string => typeof value === "string")
      : [];
    const advertised = new Set((conn.capabilities ?? []).map((value) => value.trim().toLowerCase()));
    if (required.some((value) => !advertised.has(value.trim().toLowerCase()))) return false;
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

  waitForAgentCommandAck(
    taskId: string,
    requestId: string,
    timeoutMs: number,
    options: { expectedHosts?: string[]; eventType?: string | null } = {},
  ): Promise<boolean | null> {
    const key = `${taskId}:${requestId}`;
    const normalizedHosts = Array.from(
      new Set(
        (options.expectedHosts || []).flatMap((host) => {
          const trimmed = typeof host === "string" ? host.trim() : "";
          return trimmed ? [trimmed] : [];
        }),
      ),
    );
    const expectedHosts = normalizedHosts.length > 0 ? new Set(normalizedHosts) : null;
    const pendingHosts = expectedHosts ? new Set(normalizedHosts) : null;
    const expectedEventType =
      typeof options.eventType === "string" && options.eventType.trim() ? options.eventType.trim() : null;

    return new Promise<boolean | null>((resolve) => {
      const timeout = setTimeout(() => {
        const current = this.agentCommandAckWaiters.get(key);
        this.agentCommandAckWaiters.delete(key);
        resolve(current?.sawReject ? false : null);
      }, timeoutMs);
      this.agentCommandAckWaiters.set(key, {
        resolve,
        timeout,
        expectedHosts,
        pendingHosts,
        expectedEventType,
        sawReject: false,
      });
    });
  }

  cancelTaskStopAck(taskId: string, requestId: string): boolean {
    const key = `${taskId}:${requestId}`;
    const waiter = this.stopAckWaiters.get(key);
    if (!waiter) return false;

    clearTimeout(waiter.timeout);
    this.stopAckWaiters.delete(key);
    waiter.resolve(null);
    return true;
  }

  cancelAgentCommandAck(taskId: string, requestId: string): boolean {
    const key = `${taskId}:${requestId}`;
    const waiter = this.agentCommandAckWaiters.get(key);
    if (!waiter) return false;

    clearTimeout(waiter.timeout);
    this.agentCommandAckWaiters.delete(key);
    waiter.resolve(null);
    return true;
  }

  acknowledgeTaskStop(taskId: string, requestId: string, accepted = true) {
    const key = `${taskId}:${requestId}`;
    const waiter = this.stopAckWaiters.get(key);
    if (!waiter) return;

    clearTimeout(waiter.timeout);
    this.stopAckWaiters.delete(key);
    waiter.resolve(Boolean(accepted));
  }

  acknowledgeAgentCommand(
    taskId: string,
    requestId: string,
    accepted = true,
    options: { agentHost?: string | null; eventType?: string | null } = {},
  ) {
    const key = `${taskId}:${requestId}`;
    const waiter = this.agentCommandAckWaiters.get(key);
    if (!waiter) return;

    const eventType = typeof options.eventType === "string" ? options.eventType.trim() : "";
    if (waiter.expectedEventType && eventType && waiter.expectedEventType !== eventType) {
      return;
    }

    const agentHost = typeof options.agentHost === "string" ? options.agentHost.trim() : "";
    if (waiter.expectedHosts) {
      if (!agentHost || !waiter.expectedHosts.has(agentHost)) {
        return;
      }
      waiter.pendingHosts?.delete(agentHost);
    }

    if (accepted) {
      clearTimeout(waiter.timeout);
      this.agentCommandAckWaiters.delete(key);
      waiter.resolve(true);
      return;
    }

    waiter.sawReject = true;

    if (!waiter.pendingHosts || waiter.pendingHosts.size === 0) {
      clearTimeout(waiter.timeout);
      this.agentCommandAckWaiters.delete(key);
      waiter.resolve(false);
    }
  }

  cancelTaskFinalStatus(taskId: string): number {
    const waiters = this.finalStatusWaiters.get(taskId);
    if (!waiters) return 0;

    let cancelledCount = 0;
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(null);
      cancelledCount += 1;
    }
    this.finalStatusWaiters.delete(taskId);
    return cancelledCount;
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

  waitForAiManagerResponse(
    requestId: string,
    timeoutMs: number,
    expectedUserId: string,
    expectedAgentHost: string,
  ): Promise<AiManagerResponse | null> {
    return new Promise<AiManagerResponse | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.aiManagerWaiters.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.aiManagerWaiters.set(requestId, {
        resolve,
        timeout,
        expectedUserId,
        expectedAgentHost,
      });
    });
  }

  /**
   * Deliver a response to its waiter, but only when the source socket matches
   * the user+host the request was originally addressed to. Mismatches are
   * dropped silently — the waiter remains pending and will time out normally.
   */
  resolveAiManagerResponse(
    result: AiManagerResponse,
    sourceUserId: string,
    sourceAgentHost: string,
  ) {
    const waiter = this.aiManagerWaiters.get(result.request_id);
    if (!waiter) return;
    if (waiter.expectedUserId !== sourceUserId || waiter.expectedAgentHost !== sourceAgentHost) {
      console.warn(
        `[realtimeHub] dropped ai_manager_response: requestId=${result.request_id}, expected=${waiter.expectedUserId}/${waiter.expectedAgentHost}, got=${sourceUserId}/${sourceAgentHost}`,
      );
      return;
    }
    clearTimeout(waiter.timeout);
    this.aiManagerWaiters.delete(result.request_id);
    waiter.resolve(result);
  }

  cancelAiManagerResponse(requestId: string) {
    const waiter = this.aiManagerWaiters.get(requestId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.aiManagerWaiters.delete(requestId);
    waiter.resolve(null);
  }

  waitForCustomCommandsResponse(
    requestId: string,
    timeoutMs: number,
    expectedUserId: string,
    expectedAgentHost: string,
  ): Promise<CustomCommandsResponse | null> {
    return new Promise<CustomCommandsResponse | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.customCommandsWaiters.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.customCommandsWaiters.set(requestId, {
        resolve,
        timeout,
        expectedUserId,
        expectedAgentHost,
      });
    });
  }

  resolveCustomCommandsResponse(
    result: CustomCommandsResponse,
    sourceUserId: string,
    sourceAgentHost: string,
  ) {
    const waiter = this.customCommandsWaiters.get(result.request_id);
    if (!waiter) return;
    if (waiter.expectedUserId !== sourceUserId || waiter.expectedAgentHost !== sourceAgentHost) {
      console.warn(
        `[realtimeHub] dropped custom_commands_response: requestId=${result.request_id}, expected=${waiter.expectedUserId}/${waiter.expectedAgentHost}, got=${sourceUserId}/${sourceAgentHost}`,
      );
      return;
    }
    clearTimeout(waiter.timeout);
    this.customCommandsWaiters.delete(result.request_id);
    waiter.resolve(result);
  }

  cancelCustomCommandsResponse(requestId: string) {
    const waiter = this.customCommandsWaiters.get(requestId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.customCommandsWaiters.delete(requestId);
    waiter.resolve(null);
  }

  waitForRemoteExecResponse(
    requestId: string,
    timeoutMs: number,
    expectedUserId: string,
    expectedAgentHost: string,
  ): Promise<RemoteExecResponse | null> {
    return new Promise<RemoteExecResponse | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.remoteExecWaiters.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.remoteExecWaiters.set(requestId, {
        resolve,
        timeout,
        expectedUserId,
        expectedAgentHost,
      });
    });
  }

  resolveRemoteExecResponse(
    result: RemoteExecResponse,
    sourceUserId: string,
    sourceAgentHost: string,
  ) {
    const waiter = this.remoteExecWaiters.get(result.request_id);
    if (!waiter) return;
    if (waiter.expectedUserId !== sourceUserId || waiter.expectedAgentHost !== sourceAgentHost) {
      console.warn(
        `[realtimeHub] dropped remote_exec_response: requestId=${result.request_id}, expected=${waiter.expectedUserId}/${waiter.expectedAgentHost}, got=${sourceUserId}/${sourceAgentHost}`,
      );
      return;
    }
    clearTimeout(waiter.timeout);
    this.remoteExecWaiters.delete(result.request_id);
    waiter.resolve(result);
  }

  cancelRemoteExecResponse(requestId: string) {
    const waiter = this.remoteExecWaiters.get(requestId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.remoteExecWaiters.delete(requestId);
    waiter.resolve(null);
  }

  waitForProjectPathValidation(requestId: string, timeoutMs: number): Promise<ProjectPathValidationResult | null> {
    return new Promise<ProjectPathValidationResult | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.projectPathValidationWaiters.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.projectPathValidationWaiters.set(requestId, { resolve, timeout });
    });
  }

  resolveProjectPathValidation(result: ProjectPathValidationResult) {
    const waiter = this.projectPathValidationWaiters.get(result.request_id);
    if (!waiter) return;

    clearTimeout(waiter.timeout);
    this.projectPathValidationWaiters.delete(result.request_id);
    waiter.resolve(result);
  }

  cancelProjectPathValidation(requestId: string) {
    const waiter = this.projectPathValidationWaiters.get(requestId);
    if (!waiter) return;

    clearTimeout(waiter.timeout);
    this.projectPathValidationWaiters.delete(requestId);
    waiter.resolve(null);
  }

  waitForProjectAgents(requestId: string, timeoutMs: number): Promise<ProjectAgentsResult | null> {
    return new Promise<ProjectAgentsResult | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.projectAgentsWaiters.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.projectAgentsWaiters.set(requestId, { resolve, timeout });
    });
  }

  resolveProjectAgents(result: ProjectAgentsResult) {
    const waiter = this.projectAgentsWaiters.get(result.request_id);
    if (!waiter) return;

    clearTimeout(waiter.timeout);
    this.projectAgentsWaiters.delete(result.request_id);
    waiter.resolve(result);
  }

  cancelProjectAgents(requestId: string) {
    const waiter = this.projectAgentsWaiters.get(requestId);
    if (!waiter) return;

    clearTimeout(waiter.timeout);
    this.projectAgentsWaiters.delete(requestId);
    waiter.resolve(null);
  }

  waitForTaskWorktreeCleanup(requestId: string, timeoutMs: number): Promise<TaskWorktreeCleanupResult | null> {
    return new Promise<TaskWorktreeCleanupResult | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.taskWorktreeCleanupWaiters.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.taskWorktreeCleanupWaiters.set(requestId, { resolve, timeout });
    });
  }

  resolveTaskWorktreeCleanup(result: TaskWorktreeCleanupResult) {
    const waiter = this.taskWorktreeCleanupWaiters.get(result.request_id);
    if (!waiter) return;

    clearTimeout(waiter.timeout);
    this.taskWorktreeCleanupWaiters.delete(result.request_id);
    waiter.resolve(result);
  }

  cancelTaskWorktreeCleanup(requestId: string) {
    const waiter = this.taskWorktreeCleanupWaiters.get(requestId);
    if (!waiter) return;

    clearTimeout(waiter.timeout);
    this.taskWorktreeCleanupWaiters.delete(requestId);
    waiter.resolve(null);
  }

  private findAgentConnectionByHost(host: string, userId?: string): Connection | null {
    for (const conn of this.connections.values()) {
      if (conn.kind !== "agent") continue;
      if (conn.host !== host) continue;
      // `undefined` means "any owner" (the task-id routing path). An empty
      // string must NOT silently mean that too, or a blank userId would
      // disable tenant filtering entirely.
      if (userId !== undefined && conn.userId !== userId) continue;
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
