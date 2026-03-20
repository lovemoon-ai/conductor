import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import {
  realtimeHub,
  type AgentLogCollectionResult,
  type TerminalLatencySample,
} from "@/lib/realtime/hub";

const LONG_PENDING_MS = 120_000;
const RECENT_MESSAGE_SAMPLE_SIZE = 200;
const RECENT_OUTBOX_SAMPLE_SIZE = 100;
const LOG_COLLECTION_TIMEOUT_MS = 2_500;
const LOG_COLLECTION_LOOKBACK_MS = 5 * 60_000;
const LOG_COLLECTION_TAIL_LINES = 200;

export type DiagnosisConfidence = "high" | "medium" | "low";

export type DiagnosisCode =
  | "task_terminal"
  | "execution_failure_loop"
  | "no_pending_user"
  | "ws_or_routing_issue"
  | "routing_bound_to_daemon"
  | "likely_runturn_stuck"
  | "pending_but_processing"
  | "insufficient_data";

export type DiagnosisSummary = {
  code: DiagnosisCode;
  confidence: DiagnosisConfidence;
  summary: string;
  reasons: string[];
  next_actions: string[];
};

export type MessageSummary = {
  id: string;
  role: string;
  created_at: string;
  content_preview: string;
};

export type OutboxSummary = {
  id: string;
  request_id: string;
  status: string;
  event_type: string;
  agent_host: string | null;
  task_id: string | null;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  acked_at: string | null;
};

export type FireLogSummary = {
  daemon_host: string | null;
  project_path: string | null;
  log_path: string | null;
  entries: Array<{
    timestamp: string | null;
    level: string;
    message: string;
  }>;
  truncated: boolean;
  error?: string;
  collected_at: string;
};

export type TaskDiagnosticsPayload = {
  task: {
    id: string;
    project_id: string;
    title: string;
    status: string;
    agent_host: string | null;
    execution_host: string | null;
    created_at: string;
    updated_at: string;
  };
  realtime: {
    bound_agent_host: string | null;
    bound_agent_connected: boolean;
    bound_agent_is_fire: boolean;
    assigned_agent_host: string | null;
    assigned_agent_connected: boolean;
    assigned_agent_is_fire: boolean;
    assigned_agent_disconnect_at: number | null;
    bound_agent_disconnect_at: number | null;
    configured_agent_host: string | null;
    execution_agent_host: string | null;
    connected_fire_hosts: string[];
    connected_agents: Array<{
      id: string;
      host: string;
      supported_backends: string[];
    }>;
  };
  pty_transport: {
    latest_latency_sample: {
      task_id: string;
      client_input_seq: number | null;
      client_sent_at: string | null;
      server_received_at: string | null;
      daemon_received_at: string | null;
      first_output_at: string | null;
      daemon_input_to_first_output_ms: number | null;
      client_input_to_first_output_ms: number | null;
      client_input_to_server_received_ms: number | null;
      server_received_to_daemon_received_ms: number | null;
      recorded_at: string;
    } | null;
    primary_bottleneck:
      | "client_to_server"
      | "server_to_daemon"
      | "daemon_exec"
      | "unknown"
      | null;
  };
  messages: {
    sample_size: number;
    sampled_count: number;
    total_count: number;
    latest_user: MessageSummary | null;
    latest_sdk: MessageSummary | null;
    latest_sdk_failure_key: string | null;
    latest_pending_user: MessageSummary | null;
    has_pending_user: boolean;
    pending_user_count_in_sample: number;
    pending_age_ms: number | null;
  };
  outbox: {
    available: boolean;
    error: string | null;
    sample_size: number;
    sampled_count: number;
    task_user_message_by_status: Record<string, number>;
    latest_for_pending_user: OutboxSummary | null;
    recent_task_user_messages: OutboxSummary[];
  };
  fire_logs: FireLogSummary;
  diagnosis: DiagnosisSummary;
};

const isConductorFireHost = (host: unknown): host is string =>
  typeof host === "string" && host.startsWith("conductor-fire-");

const normalizeTaskStatus = (value: unknown): string => {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "running") return "running";
  if (normalized === "killed" || normalized === "failed" || normalized === "cancelled") return "killed";
  return normalized || "unknown";
};

const normalizeRole = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const detectExecutionFailureLoopKey = (value: unknown): string | null => {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!normalized) return null;
  if (normalized.includes("pty session already spawned")) return "pty_session_already_spawned";
  if (
    normalized.includes("tui process has exited") ||
    normalized.includes("cannot proceed: tui process has exited")
  ) {
    return "tui_process_exited";
  }
  if (normalized.includes("execution_failure_loop")) return "execution_failure_loop";
  return null;
};

const toIsoOrNull = (value: Date | null | undefined): string | null =>
  value instanceof Date ? value.toISOString() : null;

const toMsOrNull = (value: string | null | undefined): number | null => {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
};

const normalizeHost = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
};

const preview = (text: unknown, limit = 140): string => {
  const content = typeof text === "string" ? text.trim() : "";
  if (!content) return "";
  return content.length > limit ? `${content.slice(0, limit)}...` : content;
};

const toMessageSummary = (message: {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}): MessageSummary => ({
  id: message.id,
  role: message.role,
  created_at: message.createdAt.toISOString(),
  content_preview: preview(message.content),
});

const isMissingAgentOutboxTableError = (error: unknown): boolean => {
  const code = (error as { code?: unknown })?.code;
  const message = String((error as { message?: unknown })?.message || "");
  return code === "P2021" && message.includes("agent_outbox");
};

const toOutboxSummary = (row: {
  id: string;
  requestId: string;
  status: string;
  eventType: string;
  agentHost: string | null;
  taskId: string | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
  ackedAt: Date | null;
}): OutboxSummary => ({
  id: row.id,
  request_id: row.requestId,
  status: row.status,
  event_type: row.eventType,
  agent_host: row.agentHost,
  task_id: row.taskId,
  attempt_count: row.attemptCount,
  last_error: row.lastError,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
  sent_at: toIsoOrNull(row.sentAt),
  acked_at: toIsoOrNull(row.ackedAt),
});

const buildFireLogSummary = (params: {
  daemonHost: string | null;
  projectPath?: string | null;
  logPath?: string | null;
  entries?: AgentLogCollectionResult["logs"];
  truncated?: boolean;
  error?: string | null;
  collectedAt?: string;
}): FireLogSummary => {
  const summary: FireLogSummary = {
    daemon_host: params.daemonHost,
    project_path: params.projectPath ?? null,
    log_path: params.logPath ?? null,
    entries: params.entries ?? [],
    truncated: Boolean(params.truncated),
    collected_at: params.collectedAt ?? new Date().toISOString(),
  };
  if (params.error) {
    summary.error = params.error;
  }
  return summary;
};

const buildPtyLatencySummary = (
  sample: TerminalLatencySample | null,
): TaskDiagnosticsPayload["pty_transport"]["latest_latency_sample"] => {
  if (!sample) {
    return null;
  }

  const clientSentAtMs = toMsOrNull(sample.client_sent_at);
  const serverReceivedAtMs = toMsOrNull(sample.server_received_at);
  const daemonReceivedAtMs = toMsOrNull(sample.daemon_received_at);
  const firstOutputAtMs = toMsOrNull(sample.first_output_at);

  return {
    task_id: sample.task_id,
    client_input_seq: sample.client_input_seq ?? null,
    client_sent_at: sample.client_sent_at ?? null,
    server_received_at: sample.server_received_at ?? null,
    daemon_received_at: sample.daemon_received_at ?? null,
    first_output_at: sample.first_output_at ?? null,
    daemon_input_to_first_output_ms: sample.daemon_input_to_first_output_ms ?? null,
    client_input_to_first_output_ms:
      clientSentAtMs !== null && firstOutputAtMs !== null ? Math.max(0, firstOutputAtMs - clientSentAtMs) : null,
    client_input_to_server_received_ms:
      clientSentAtMs !== null && serverReceivedAtMs !== null ? Math.max(0, serverReceivedAtMs - clientSentAtMs) : null,
    server_received_to_daemon_received_ms:
      serverReceivedAtMs !== null && daemonReceivedAtMs !== null
        ? Math.max(0, daemonReceivedAtMs - serverReceivedAtMs)
        : null,
    recorded_at: sample.recorded_at,
  };
};

const detectPrimaryPtyBottleneck = (
  sample: TaskDiagnosticsPayload["pty_transport"]["latest_latency_sample"],
): TaskDiagnosticsPayload["pty_transport"]["primary_bottleneck"] => {
  if (!sample) {
    return null;
  }

  const candidates = [
    {
      key: "client_to_server" as const,
      value: sample.client_input_to_server_received_ms,
    },
    {
      key: "server_to_daemon" as const,
      value: sample.server_received_to_daemon_received_ms,
    },
    {
      key: "daemon_exec" as const,
      value: sample.daemon_input_to_first_output_ms,
    },
  ].filter((entry) => typeof entry.value === "number" && Number.isFinite(entry.value) && entry.value >= 0);

  if (candidates.length === 0) {
    return "unknown";
  }

  candidates.sort((a, b) => (b.value as number) - (a.value as number));
  return candidates[0]?.key ?? "unknown";
};

const parseTaskMetadata = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
};

const extractTaskMetadataDaemonName = (value: unknown): string | null => {
  const metadata = parseTaskMetadata(value);
  return normalizeHost(metadata?.daemonName);
};

const isTaskNotFoundInSessionStoreError = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.includes("Task not found in session store");

const fireLogFailureRank = (summary: FireLogSummary): number => {
  if (!summary.error) return 3;
  if (summary.project_path || summary.log_path || summary.entries.length > 0) return 2;
  if (isTaskNotFoundInSessionStoreError(summary.error)) return 0;
  return 1;
};

const shouldReplaceBestFireLogFailure = (
  nextSummary: FireLogSummary,
  currentBest: FireLogSummary | null,
): boolean => {
  if (!currentBest) return true;
  const nextRank = fireLogFailureRank(nextSummary);
  const currentRank = fireLogFailureRank(currentBest);
  if (nextRank !== currentRank) {
    return nextRank > currentRank;
  }
  if (nextSummary.entries.length !== currentBest.entries.length) {
    return nextSummary.entries.length > currentBest.entries.length;
  }
  if (!currentBest.daemon_host && nextSummary.daemon_host) {
    return true;
  }
  return false;
};

const buildDiagnosticsDaemonCandidates = (params: {
  connectedAgents: Array<{ host: string }>;
  metadataDaemonName: string | null;
  configuredAgentHost: string | null;
  executionAgentHost: string | null;
  boundAgentHost: string | null;
}): string[] => {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | null) => {
    if (!value || isConductorFireHost(value) || seen.has(value)) {
      return;
    }
    seen.add(value);
    candidates.push(value);
  };

  add(params.metadataDaemonName);
  add(params.configuredAgentHost);
  add(params.executionAgentHost);
  add(params.boundAgentHost);
  for (const agent of params.connectedAgents) {
    add(normalizeHost(agent.host));
  }

  return candidates;
};

const buildLogCollectionSince = (date: Date | null): string | undefined => {
  if (!(date instanceof Date)) {
    return undefined;
  }
  return new Date(Math.max(0, date.getTime() - LOG_COLLECTION_LOOKBACK_MS)).toISOString();
};

async function collectFireLogsFromDaemon(params: {
  userId: string;
  taskId: string;
  daemonHost: string;
  since?: string;
}): Promise<FireLogSummary> {
  const { userId, taskId, daemonHost, since } = params;
  const collectedAt = new Date().toISOString();
  if (!realtimeHub.hasAgentHost(daemonHost, userId)) {
    return buildFireLogSummary({
      daemonHost,
      error: `Daemon host offline: ${daemonHost}`,
      collectedAt,
    });
  }

  const requestId = randomUUID();
  const waitForLogs = realtimeHub.waitForAgentLogCollection(requestId, LOG_COLLECTION_TIMEOUT_MS);
  const sent = realtimeHub.sendToAgentHost(userId, daemonHost, {
    type: "collect_logs",
    payload: {
      request_id: requestId,
      task_id: taskId,
      options: {
        tail_lines: LOG_COLLECTION_TAIL_LINES,
        since,
      },
    },
  });
  if (!sent) {
    realtimeHub.cancelAgentLogCollection(requestId);
    return buildFireLogSummary({
      daemonHost,
      error: `Failed to send collect_logs to daemon host ${daemonHost}`,
      collectedAt,
    });
  }

  const result = await waitForLogs;
  if (!result) {
    return buildFireLogSummary({
      daemonHost,
      error: "Timeout waiting for logs",
      collectedAt,
    });
  }

  return buildFireLogSummary({
    daemonHost: normalizeHost(result.daemon_host) ?? daemonHost,
    projectPath: result.project_path,
    logPath: result.log_path,
    entries: result.logs,
    truncated: result.truncated,
    error: result.error,
    collectedAt: result.collected_at,
  });
}

async function collectFireLogs(params: {
  userId: string;
  taskId: string;
  daemonHosts: string[];
  since?: string;
}): Promise<FireLogSummary> {
  const { userId, taskId, daemonHosts, since } = params;
  if (daemonHosts.length === 0) {
    return buildFireLogSummary({
      daemonHost: null,
      error: "No daemon host available for this task",
    });
  }

  let bestFailureSummary: FireLogSummary | null = null;
  for (const daemonHost of daemonHosts) {
    const summary = await collectFireLogsFromDaemon({
      userId,
      taskId,
      daemonHost,
      since,
    });
    if (!summary.error) {
      return summary;
    }
    if (shouldReplaceBestFireLogFailure(summary, bestFailureSummary)) {
      bestFailureSummary = summary;
    }
  }

  return (
    bestFailureSummary ??
    buildFireLogSummary({
      daemonHost: null,
      error: "Task not found in session store",
    })
  );
}

function classifyDiagnosis(input: {
  taskStatus: string;
  hasPendingUser: boolean;
  pendingAgeMs: number | null;
  outboxAvailable: boolean;
  latestPendingOutbox: OutboxSummary | null;
  latestSdkFailureKey: string | null;
  boundHost: string | null;
  boundHostConnected: boolean;
  assignedHost: string | null;
  assignedHostConnected: boolean;
  anyFireConnected: boolean;
  boundHostIsFire: boolean;
  assignedHostIsFire: boolean;
}): DiagnosisSummary {
  const pendingAgeSeconds =
    typeof input.pendingAgeMs === "number" ? Math.max(0, Math.round(input.pendingAgeMs / 1000)) : null;
  const longPending = typeof input.pendingAgeMs === "number" && input.pendingAgeMs >= LONG_PENDING_MS;

  if (input.taskStatus === "completed" || input.taskStatus === "killed") {
    return {
      code: "task_terminal",
      confidence: "high",
      summary: `task is already ${input.taskStatus}`,
      reasons: [`task.status=${input.taskStatus}`],
      next_actions: [],
    };
  }

  if (!input.hasPendingUser) {
    if (input.latestSdkFailureKey) {
      return {
        code: "execution_failure_loop",
        confidence: "high",
        summary: "latest sdk message indicates repeated execution-layer failure",
        reasons: [
          "no pending user message newer than latest sdk reply",
          `latest sdk failure key=${input.latestSdkFailureKey}`,
        ],
        next_actions: [
          "restart the task's fire process and ensure stale PTY child process is cleared",
          "if repeated, move user to a new task and mark old task as killed with failure reason",
        ],
      };
    }
    return {
      code: "no_pending_user",
      confidence: "high",
      summary: "no pending user message newer than latest sdk reply",
      reasons: ["latest user message is not newer than latest sdk message"],
      next_actions: [],
    };
  }

  if (input.boundHost && !input.boundHostIsFire) {
    return {
      code: "routing_bound_to_daemon",
      confidence: "high",
      summary: "task is currently bound to a daemon host instead of a fire host",
      reasons: [
        `bound host=${input.boundHost}`,
        "task_user_message should be consumed by fire hosts",
      ],
      next_actions: [
        "wait for fire host resume to rebind this task",
        "check websocket reconnect and agent_resume flow",
      ],
    };
  }

  if (input.outboxAvailable && input.latestPendingOutbox) {
    const status = String(input.latestPendingOutbox.status || "").toLowerCase();
    const lastError = String(input.latestPendingOutbox.last_error || "");

    if (status === "failed") {
      return {
        code: "ws_or_routing_issue",
        confidence: "high",
        summary: "pending user message failed in outbox delivery",
        reasons: [
          `outbox status=${input.latestPendingOutbox.status}`,
          input.latestPendingOutbox.last_error
            ? `last_error=${input.latestPendingOutbox.last_error}`
            : "outbox row has failed status",
        ],
        next_actions: [
          "check fire/daemon websocket connectivity",
          "inspect outbox retry and host binding for this task",
        ],
      };
    }

    if (status === "pending" || status === "sent") {
      if (lastError.includes("send_to_agent_host_failed")) {
        return {
          code: "ws_or_routing_issue",
          confidence: "high",
          summary: "outbox cannot send to target agent host",
          reasons: [
            "outbox status is pending/sent",
            `last_error=${input.latestPendingOutbox.last_error || "send_to_agent_host_failed"}`,
          ],
          next_actions: [
            "verify target host is connected and bound",
            "inspect backend /ws/agent stability",
          ],
        };
      }

      if (!input.boundHostConnected && !input.assignedHostConnected && !input.anyFireConnected) {
        return {
          code: "ws_or_routing_issue",
          confidence: "high",
          summary: "pending user message and no fire/assigned host is online",
          reasons: [
            "outbox message is not acked",
            "bound/assigned host are both offline",
          ],
          next_actions: [
            "check fire process liveness and websocket reconnect",
            "check reverse proxy websocket timeout/reset in production",
          ],
        };
      }

      return {
        code: "pending_but_processing",
        confidence: longPending ? "medium" : "low",
        summary: "pending user message is queued or in-delivery",
        reasons: [
          `outbox status=${input.latestPendingOutbox.status}`,
          pendingAgeSeconds !== null ? `pending_age=${pendingAgeSeconds}s` : "pending_age=unknown",
        ],
        next_actions: longPending
          ? ["if pending age keeps growing, inspect host binding and outbox retry loop"]
          : [],
      };
    }

    if (status === "acked") {
      if (longPending) {
        return {
          code: "likely_runturn_stuck",
          confidence: "high",
          summary: "user message has been acked by agent but no sdk reply for a long time",
          reasons: [
            "outbox status=acked",
            pendingAgeSeconds !== null ? `pending_age=${pendingAgeSeconds}s` : "pending_age=unknown",
            input.boundHostConnected ? "bound host still connected" : "bound host currently offline",
          ],
          next_actions: [
            "inspect fire logs for repeated turn waiting on same replyTo",
            "enable CONDUCTOR_TUI_TRACE=1 / CONDUCTOR_DEBUG=1 for runTurn progression",
          ],
        };
      }

      return {
        code: "pending_but_processing",
        confidence: "medium",
        summary: "agent acknowledged the message; response may still be in progress",
        reasons: [
          "outbox status=acked",
          pendingAgeSeconds !== null ? `pending_age=${pendingAgeSeconds}s` : "pending_age=unknown",
        ],
        next_actions: [],
      };
    }
  }

  if (!input.boundHostConnected && !input.assignedHostConnected) {
    return {
      code: "ws_or_routing_issue",
      confidence: "medium",
      summary: "pending user message while both bound and assigned hosts appear offline",
      reasons: [
        input.boundHost ? `bound host ${input.boundHost} offline` : "no bound host",
        input.assignedHost ? `assigned host ${input.assignedHost} offline` : "no assigned host",
      ],
      next_actions: [
        "check websocket reconnect and agent_resume logs",
        "confirm task is rebound to a live fire host",
      ],
    };
  }

  if (longPending && input.boundHostConnected) {
    return {
      code: "likely_runturn_stuck",
      confidence: "medium",
      summary: "pending user message is old while bound host is still online",
      reasons: [
        pendingAgeSeconds !== null ? `pending_age=${pendingAgeSeconds}s` : "pending_age=unknown",
        `bound host ${input.boundHost || "n/a"} is connected`,
      ],
      next_actions: [
        "inspect fire log for runTurn stuck state",
        "verify TUI signal patterns for current backend version",
      ],
    };
  }

  return {
    code: "insufficient_data",
    confidence: "low",
    summary: "insufficient signals to determine a single root cause",
    reasons: [
      "pending user message exists",
      "available signals are inconclusive",
    ],
    next_actions: [
      "collect fire log around the task's latest user message timestamp",
      "check outbox status and host binding changes over time",
    ],
  };
}

export async function buildTaskDiagnosticsPayload(params: {
  userId: string;
  taskId: string;
  includeRemoteFireLogs?: boolean;
}): Promise<TaskDiagnosticsPayload | null> {
  const { userId, taskId, includeRemoteFireLogs = true } = params;

  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId } },
    select: {
      id: true,
      projectId: true,
      title: true,
      status: true,
      agentHost: true,
      executionHost: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!task) {
    return null;
  }

  const recentMessages = await db.message.findMany({
    where: { taskId: task.id },
    orderBy: { createdAt: "desc" },
    take: RECENT_MESSAGE_SAMPLE_SIZE,
    select: {
      id: true,
      role: true,
      content: true,
      createdAt: true,
    },
  });

  const totalMessageCount = await db.message.count({
    where: { taskId: task.id },
  });

  const latestUserMessage =
    recentMessages.find((message) => normalizeRole(message.role) === "user") ?? null;
  const latestSdkMessage =
    recentMessages.find((message) => {
      const role = normalizeRole(message.role);
      return role === "sdk" || role === "assistant";
    }) ?? null;
  const latestSdkFailureKey = detectExecutionFailureLoopKey(latestSdkMessage?.content);

  const latestSdkTime = latestSdkMessage?.createdAt?.getTime?.() ?? Number.NaN;
  const pendingUserMessages = recentMessages.filter((message) => {
    if (normalizeRole(message.role) !== "user") return false;
    if (!Number.isFinite(latestSdkTime)) return true;
    return message.createdAt.getTime() > latestSdkTime;
  });

  const latestPendingUserMessage = pendingUserMessages[0] ?? null;
  const pendingUserAgeMs = latestPendingUserMessage
    ? Date.now() - latestPendingUserMessage.createdAt.getTime()
    : null;

  const connectedAgents = realtimeHub.getAgentsForUser(userId);
  const boundAgentHost = realtimeHub.getTaskAgentHost(task.id);
  const configuredAgentHost = normalizeHost(task.agentHost);
  const executionAgentHost = normalizeHost(task.executionHost);
  const assignedAgentHost = executionAgentHost || configuredAgentHost;
  const metadataDaemonName = extractTaskMetadataDaemonName(task.metadata);
  const diagnosticsDaemonHosts = buildDiagnosticsDaemonCandidates({
    connectedAgents,
    metadataDaemonName,
    configuredAgentHost,
    executionAgentHost,
    boundAgentHost,
  });
  const boundHostConnected = boundAgentHost ? realtimeHub.hasAgentHost(boundAgentHost, userId) : false;
  const assignedHostConnected = assignedAgentHost
    ? realtimeHub.hasAgentHost(assignedAgentHost, userId)
    : false;
  const fireHostsConnected = connectedAgents.filter((agent) => isConductorFireHost(agent.host));

  const disconnectAtForAssignedHost = assignedAgentHost
    ? realtimeHub.getAgentDisconnectAt(assignedAgentHost, userId)
    : null;
  const disconnectAtForBoundHost =
    boundAgentHost && boundAgentHost !== assignedAgentHost
      ? realtimeHub.getAgentDisconnectAt(boundAgentHost, userId)
      : null;

  let outboxAvailable = true;
  let outboxError: string | null = null;
  let outboxRows: OutboxSummary[] = [];

  try {
    const rawRows = await db.agentOutbox.findMany({
      where: {
        userId,
        taskId: task.id,
      },
      orderBy: { createdAt: "desc" },
      take: RECENT_OUTBOX_SAMPLE_SIZE,
      select: {
        id: true,
        requestId: true,
        status: true,
        eventType: true,
        agentHost: true,
        taskId: true,
        attemptCount: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
        sentAt: true,
        ackedAt: true,
      },
    });
    outboxRows = rawRows.map(toOutboxSummary);
  } catch (error) {
    if (isMissingAgentOutboxTableError(error)) {
      outboxAvailable = false;
      outboxError = "agent_outbox table missing";
    } else {
      throw error;
    }
  }

  const taskUserOutboxRows = outboxRows.filter((row) => row.event_type === "task_user_message");
  const latestPendingOutbox = latestPendingUserMessage
    ? taskUserOutboxRows.find((row) => row.request_id === latestPendingUserMessage.id) ?? null
    : null;
  const outboxByStatus = taskUserOutboxRows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.status || "unknown").toLowerCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const fireLogs = includeRemoteFireLogs
    ? await collectFireLogs({
        userId,
        taskId: task.id,
        daemonHosts: diagnosticsDaemonHosts,
        since: buildLogCollectionSince(latestPendingUserMessage?.createdAt ?? latestUserMessage?.createdAt ?? null),
      })
    : buildFireLogSummary({
        daemonHost: diagnosticsDaemonHosts[0] ?? null,
        error: "Remote fire log collection skipped",
      });

  const diagnosis = classifyDiagnosis({
    taskStatus: normalizeTaskStatus(task.status),
    hasPendingUser: Boolean(latestPendingUserMessage),
    pendingAgeMs: typeof pendingUserAgeMs === "number" ? pendingUserAgeMs : null,
    outboxAvailable,
    latestPendingOutbox,
    latestSdkFailureKey,
    boundHost: boundAgentHost,
    boundHostConnected,
    assignedHost: assignedAgentHost,
    assignedHostConnected,
    anyFireConnected: fireHostsConnected.length > 0,
    boundHostIsFire: isConductorFireHost(boundAgentHost),
    assignedHostIsFire: isConductorFireHost(assignedAgentHost),
  });
  const ptyLatencySample = buildPtyLatencySummary(realtimeHub.getTerminalLatencySample(task.id));
  const ptyPrimaryBottleneck = detectPrimaryPtyBottleneck(ptyLatencySample);

  return {
    task: {
      id: task.id,
      project_id: task.projectId,
      title: task.title,
      status: normalizeTaskStatus(task.status),
      agent_host: configuredAgentHost,
      execution_host: executionAgentHost,
      created_at: task.createdAt.toISOString(),
      updated_at: task.updatedAt.toISOString(),
    },
    realtime: {
      bound_agent_host: boundAgentHost,
      bound_agent_connected: boundHostConnected,
      bound_agent_is_fire: isConductorFireHost(boundAgentHost),
      assigned_agent_host: assignedAgentHost,
      assigned_agent_connected: assignedHostConnected,
      assigned_agent_is_fire: isConductorFireHost(assignedAgentHost),
      assigned_agent_disconnect_at: disconnectAtForAssignedHost,
      bound_agent_disconnect_at: disconnectAtForBoundHost,
      configured_agent_host: configuredAgentHost,
      execution_agent_host: executionAgentHost,
      connected_fire_hosts: fireHostsConnected.map((agent) => agent.host),
      connected_agents: connectedAgents.map((agent) => ({
        id: agent.id,
        host: agent.host,
        supported_backends: agent.supportedBackends,
      })),
    },
    pty_transport: {
      latest_latency_sample: ptyLatencySample,
      primary_bottleneck: ptyPrimaryBottleneck,
    },
    messages: {
      sample_size: RECENT_MESSAGE_SAMPLE_SIZE,
      sampled_count: recentMessages.length,
      total_count: totalMessageCount,
      latest_user: latestUserMessage ? toMessageSummary(latestUserMessage) : null,
      latest_sdk: latestSdkMessage ? toMessageSummary(latestSdkMessage) : null,
      latest_sdk_failure_key: latestSdkFailureKey,
      latest_pending_user: latestPendingUserMessage
        ? toMessageSummary(latestPendingUserMessage)
        : null,
      has_pending_user: Boolean(latestPendingUserMessage),
      pending_user_count_in_sample: pendingUserMessages.length,
      pending_age_ms: typeof pendingUserAgeMs === "number" ? Math.max(0, pendingUserAgeMs) : null,
    },
    outbox: {
      available: outboxAvailable,
      error: outboxError,
      sample_size: RECENT_OUTBOX_SAMPLE_SIZE,
      sampled_count: outboxRows.length,
      task_user_message_by_status: outboxByStatus,
      latest_for_pending_user: latestPendingOutbox,
      recent_task_user_messages: taskUserOutboxRows.slice(0, 20),
    },
    fire_logs: fireLogs,
    diagnosis,
  };
}
