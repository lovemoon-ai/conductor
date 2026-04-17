import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import {
  realtimeHub,
  type AgentLogCollectionResult,
  type ProjectPathValidationResult,
  type TaskWorktreeCleanupResult,
} from "./hub";
import { authenticateToken } from "../auth/service";
import { randomUUID } from "crypto";
import { db } from "../db";
import {
  commitAgentCommandAck,
  commitSdkMessage,
  commitTaskStopAck,
  commitTaskStatusUpdate,
  drainAgentOutboxForHost,
} from "./agent-upstream";
import { outboxProcessor } from "../outbox-processor";
import {
  isConductorFireHost,
} from "@/lib/subscription/plan-limits";
import {
  isMissingAnyNewSchemaError,
  isMissingPtySchemaError,
  legacyTaskSelect,
  taskSelectWithoutIssueId,
  withPtySchemaFallback,
} from "@/lib/tasks/pty-compat";
import { normalizeTaskStatus } from "@/lib/tasks/task-config";

export const AGENT_WS_PATH = "/ws/agent";

type TaskOwnershipRecord = {
  id: string;
  agentHost: string | null;
  executionHost: string | null;
  status?: string | null;
  taskType?: string | null;
};

type AgentEvent =
  | { type: "create_task"; payload: { task_id: string; project_id: string; title: string; prefill?: string } }
  | { type: "sdk_message"; payload: { task_id: string; content: string; metadata?: Record<string, unknown>; message_id?: string } }
  | { type: "task_status_update"; payload: { task_id: string; status: string; summary?: string; project_id?: string } }
  | { type: "task_stop_ack"; payload: { task_id: string; request_id: string; accepted?: boolean } }
  | {
      type: "agent_command_ack";
      payload: {
        request_id: string;
        task_id?: string;
        event_type?: string;
        accepted?: boolean;
      };
    }
  | {
      type: "agent_resume";
      payload: {
        active_tasks?: string[];
        source?: string;
        metadata?: Record<string, unknown>;
        last_applied_cursor?: {
          created_at?: string;
          request_id?: string;
        };
      };
    }
  | {
      type: "project_path_validated";
      payload: {
        request_id: string;
        daemon_host?: string;
        workspace_path?: string | null;
        repo_root?: string | null;
        worktree_branch?: string | null;
        last_commit?: string | null;
        file_count?: number | string | null;
        error?: string | null;
        error_code?: string | null;
        validated_at?: string;
      };
    }
  | {
      type: "task_worktree_cleanup_result";
      payload: {
        request_id: string;
        task_id: string;
        daemon_host?: string;
        worktree_branch?: string | null;
        removed_path?: string | null;
        cleaned?: boolean;
        error?: string | null;
        cleaned_at?: string;
      };
    }
  | {
      type: "terminal_opened";
      payload: {
        task_id: string;
        project_id?: string;
        pty_session_id?: string;
        pid?: number | string | null;
        cwd?: string;
        shell?: string;
        cols?: number | string | null;
        rows?: number | string | null;
        started_at?: string;
      };
    }
  | {
      type: "terminal_output";
      payload: {
        task_id: string;
        project_id?: string;
        pty_session_id?: string;
        seq?: number | string | null;
        data?: string;
        latency_sample?: {
          client_input_seq?: number | string | null;
          client_sent_at?: string;
          server_received_at?: string;
          daemon_received_at?: string;
          first_output_at?: string;
          daemon_input_to_first_output_ms?: number | string | null;
        };
      };
    }
  | {
      type: "terminal_snapshot";
      payload: {
        task_id: string;
        project_id?: string;
        pty_session_id?: string;
        connection_id?: string;
        last_seq?: number | string | null;
        data?: string;
        truncated?: boolean;
      };
    }
  | {
      type: "terminal_exit";
      payload: {
        task_id: string;
        project_id?: string;
        pty_session_id?: string;
        exit_code?: number | string | null;
        signal?: number | string | null;
        seq?: number | string | null;
        closed_at?: string;
      };
    }
  | {
      type: "terminal_error";
      payload: {
        task_id: string;
        project_id?: string;
        pty_session_id?: string;
        message?: string;
      };
    }
  | {
      type: "pty_transport_status";
      payload: {
        task_id: string;
        session_id?: string;
        connection_id?: string;
        transport_state?: string;
        transport_policy?: string;
        writer_connection_id?: string;
        direct_candidate?: boolean;
        reason?: string;
      };
    }
  | {
      type: "pty_transport_signal";
      payload: {
        task_id: string;
        session_id?: string;
        connection_id?: string;
        signal_type?: string;
        description?: Record<string, unknown>;
        candidate?: Record<string, unknown>;
      };
    }
  | {
      type: "task_runtime_status";
      payload: {
        task_id: string;
        state?: string;
        phase?: string;
        source?: string;
        reply_in_progress?: boolean;
        status_line?: string;
        status_done_line?: string;
        reply_preview?: string;
        reply_to?: string;
        backend?: string;
        thread_id?: string;
        daemon?: string;
        pid?: number;
        session_id?: string;
        session_file_path?: string;
        token_usage_percent?: number;
        context_usage_percent?: number;
        created_at?: string;
      };
    }
  | {
      type: "agent_log_collected";
      payload: {
        request_id: string;
        task_id: string;
        daemon_host?: string;
        project_path?: string | null;
        log_path?: string | null;
        logs?: Array<{ timestamp?: string | null; level?: string; message?: string }>;
        truncated?: boolean;
        error?: string | null;
        collected_at?: string;
      };
    }
  | { type: "heartbeat"; payload?: Record<string, unknown> };

const persistTaskExecutionHost = async (
  userId: string,
  taskId: string,
  agentHost: string,
): Promise<void> => {
  const normalizedHost = agentHost.trim();
  if (!normalizedHost) return;
  try {
    await db.task.updateMany({
      where: {
        id: taskId,
        project: { userId },
        OR: [
          { executionHost: null },
          { executionHost: { not: normalizedHost } },
        ],
      },
      data: { executionHost: normalizedHost },
    });
  } catch (error) {
    console.warn(
      `[agent-gateway] failed to persist execution host for task ${taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

export const bindActiveTasksFromResume = async (
  userId: string,
  agentHost: string,
  activeTasks: unknown,
): Promise<number> => {
  if (!Array.isArray(activeTasks) || activeTasks.length === 0) {
    return 0;
  }
  const ids = activeTasks
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  if (ids.length === 0) {
    return 0;
  }
  const tasks = await withPtySchemaFallback(
    "agent-gateway.bindActiveTasksFromResume",
    () =>
      db.task.findMany({
        where: {
          id: { in: Array.from(new Set(ids)) },
          project: { userId },
        },
        select: {
          id: true,
          agentHost: true,
          executionHost: true,
          status: true,
          taskType: true,
        },
      }),
    async () =>
      (await db.task.findMany({
        where: {
          id: { in: Array.from(new Set(ids)) },
          project: { userId },
        },
        select: {
          id: true,
          agentHost: true,
          executionHost: true,
          status: true,
        },
      })).map((task) => ({
        ...task,
        taskType: "ai_task",
      })),
  );
  const tasksToBind = tasks.filter((task) => {
    const assignedHost = normalizeOptionalString(task.executionHost) || normalizeOptionalString(task.agentHost);
    const status = normalizeTaskStatus(task.status);
    const allowFireHostClaim = assignedHost !== agentHost && canFireHostClaimTask(task, agentHost);
    return (assignedHost === agentHost || allowFireHostClaim) && (status === "init" || status === "running" || status === "unknown");
  });
  for (const task of tasksToBind) {
    realtimeHub.bindTaskToAgent(task.id, agentHost);
  }
  if (tasksToBind.length > 0) {
    const taskIds = tasksToBind.map((task) => task.id);
    await db.task.updateMany({
      where: {
        id: { in: taskIds },
        project: { userId },
        OR: [
          { executionHost: null },
          { executionHost: { not: agentHost } },
        ],
      },
      data: { executionHost: agentHost },
    });
  }
  return tasksToBind.length;
};

export const processAgentResume = async (args: {
  userId: string;
  agentHost: string;
  payload: Extract<AgentEvent, { type: "agent_resume" }>["payload"];
}): Promise<{ boundCount: number; source: string }> => {
  const source = typeof args.payload.source === "string" ? args.payload.source : "";
  const boundCount = await bindActiveTasksFromResume(args.userId, args.agentHost, args.payload.active_tasks);
  await drainAgentOutboxForHost(args.userId, args.agentHost, {
    ignoreRetryAt: true,
  });
  return {
    boundCount,
    source,
  };
};

const getOwnedPtyTask = async (userId: string, taskId: string) =>
  withPtySchemaFallback(
    "agent-gateway.getOwnedPtyTask",
    () =>
      db.task.findFirst({
        where: {
          id: taskId,
          taskType: "pty_task",
          project: { userId },
        },
        include: {
          ptySession: true,
          taskStatusEvents: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              status: true,
              summary: true,
            },
          },
        },
      }),
    async () => null,
  );

const broadcastTaskStatusUpdate = (userId: string, projectId: string, taskId: string, status: string, summary?: string | null) => {
  realtimeHub.notifyTaskStatus(taskId, status);
  realtimeHub.broadcast(userId, projectId, {
    type: "task_status_update",
    payload: {
      task_id: taskId,
      project_id: projectId,
      status,
      ...(summary ? { summary } : {}),
    },
  });
};

const sendEnvelope = (socket: WebSocket, envelope: Record<string, unknown>) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(envelope));
};


const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
};

const normalizePositiveInt = (value: unknown): number | null => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return null;
};

const normalizeNonNegativeInt = (value: unknown): number | null => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return null;
};

const normalizeIsoTimestamp = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return Number.isNaN(Date.parse(normalized)) ? null : normalized;
};

const normalizeTerminalLatencySample = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const sample = value as Record<string, unknown>;
  const normalized = {
    client_input_seq: normalizeNonNegativeInt(sample.client_input_seq ?? sample.clientInputSeq) ?? undefined,
    client_sent_at: normalizeIsoTimestamp(sample.client_sent_at ?? sample.clientSentAt) ?? undefined,
    server_received_at: normalizeIsoTimestamp(sample.server_received_at ?? sample.serverReceivedAt) ?? undefined,
    daemon_received_at: normalizeIsoTimestamp(sample.daemon_received_at ?? sample.daemonReceivedAt) ?? undefined,
    first_output_at: normalizeIsoTimestamp(sample.first_output_at ?? sample.firstOutputAt) ?? undefined,
    daemon_input_to_first_output_ms:
      normalizeNonNegativeInt(sample.daemon_input_to_first_output_ms ?? sample.daemonInputToFirstOutputMs) ??
      undefined,
  };

  return Object.values(normalized).some((entry) => entry !== undefined) ? normalized : undefined;
};

const normalizeExitSignal = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(value);
  }
  return normalizeOptionalString(value);
};

const normalizePtyTaskStatus = (exitCode: number | null, signal: string | null): "completed" | "killed" =>
  !signal && exitCode === 0 ? "completed" : "killed";

const normalizeIsoDate = (value: unknown, fallback: string): string => {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return fallback;
  }
  return Number.isNaN(Date.parse(normalized)) ? fallback : normalized;
};

const normalizeAgentLogEntries = (value: unknown): AgentLogCollectionResult["logs"] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const timestamp =
        entry?.timestamp === null ? null : normalizeOptionalString(entry?.timestamp);
      const message = normalizeOptionalString(entry?.message);
      if (!message) {
        return null;
      }
      return {
        timestamp,
        level: normalizeOptionalString(entry?.level) || "INFO",
        message,
      };
    })
    .filter((entry): entry is AgentLogCollectionResult["logs"][number] => Boolean(entry));
};

const normalizeProjectPathValidationResult = (
  payload: Record<string, unknown>,
  agentHost: string,
): ProjectPathValidationResult | null => {
  const requestId = normalizeOptionalString(payload.request_id);
  if (!requestId) {
    return null;
  }

  return {
    request_id: requestId,
    daemon_host: normalizeOptionalString(payload.daemon_host) || agentHost,
    workspace_path: normalizeOptionalString(payload.workspace_path),
    repo_root: normalizeOptionalString(payload.repo_root),
    worktree_branch: normalizeOptionalString(payload.worktree_branch),
    last_commit: normalizeOptionalString(payload.last_commit),
    file_count: normalizeNonNegativeInt(payload.file_count),
    error: normalizeOptionalString(payload.error),
    error_code: normalizeOptionalString(payload.error_code),
    validated_at: normalizeIsoDate(payload.validated_at, new Date().toISOString()),
  };
};

const normalizeTaskWorktreeCleanupResult = (
  payload: Record<string, unknown>,
  agentHost: string,
): TaskWorktreeCleanupResult | null => {
  const requestId = normalizeOptionalString(payload.request_id);
  const taskId = normalizeOptionalString(payload.task_id);
  if (!requestId || !taskId) {
    return null;
  }

  return {
    request_id: requestId,
    task_id: taskId,
    daemon_host: normalizeOptionalString(payload.daemon_host) || agentHost,
    worktree_branch: normalizeOptionalString(payload.worktree_branch),
    removed_path: normalizeOptionalString(payload.removed_path),
    cleaned: payload.cleaned !== false,
    error: normalizeOptionalString(payload.error),
    cleaned_at: normalizeIsoDate(payload.cleaned_at, new Date().toISOString()),
  };
};

const getAssignedTaskHost = (task: TaskOwnershipRecord): string | null =>
  normalizeOptionalString(task.executionHost) || normalizeOptionalString(task.agentHost);

const canFireHostClaimTask = (task: TaskOwnershipRecord, agentHost: string): boolean => {
  const daemonHost = normalizeOptionalString(task.agentHost);
  return (
    isConductorFireHost(agentHost) &&
    normalizeOptionalString(task.taskType) === "ai_task" &&
    Boolean(daemonHost) &&
    !isConductorFireHost(daemonHost)
  );
};

export const ensureAgentOwnsTask = async (
  userId: string,
  task: TaskOwnershipRecord,
  agentHost: string,
): Promise<void> => {
  const assignedHost = getAssignedTaskHost(task);
  if (!assignedHost) {
    throw new Error(`Task ${task.id} has no assigned agent host`);
  }
  const allowFireHostClaim = assignedHost !== agentHost && canFireHostClaimTask(task, agentHost);
  if (!allowFireHostClaim && assignedHost !== agentHost) {
    throw new Error(`Task ${task.id} is assigned to ${assignedHost}, not ${agentHost}`);
  }

  const boundHost = realtimeHub.getTaskAgentHost(task.id);
  if (boundHost && boundHost !== agentHost && realtimeHub.hasAgentHost(boundHost, userId)) {
    if (allowFireHostClaim && !isConductorFireHost(boundHost)) {
      realtimeHub.bindTaskToAgent(task.id, agentHost);
      await persistTaskExecutionHost(userId, task.id, agentHost);
      return;
    }
    const ownerKind = isConductorFireHost(boundHost) ? "fire host" : "agent host";
    throw new Error(`Task ${task.id} is already handled by active ${ownerKind} ${boundHost}`);
  }

  realtimeHub.bindTaskToAgent(task.id, agentHost);
  await persistTaskExecutionHost(userId, task.id, agentHost);
};

const extractToken = (req: IncomingMessage): string | undefined => {
  const header = req.headers["authorization"];
  if (!header || Array.isArray(header)) return undefined;
  const [, token] = header.split(" ");
  return token;
};

const extractHost = (req: IncomingMessage): string | undefined => {
  const header = req.headers["x-conductor-host"];
  return Array.isArray(header) ? header[0] : (header as string | undefined);
};

const extractSupportedBackends = (req: IncomingMessage): string[] => {
  const header = req.headers["x-conductor-backends"];
  const value = Array.isArray(header) ? header[0] : (header as string | undefined);
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
};

const extractRuntimeBackendMap = (req: IncomingMessage): Record<string, string> => {
  const header = req.headers["x-conductor-backend-runtime-map"];
  const value = Array.isArray(header) ? header[0] : (header as string | undefined);
  if (!value) {
    return {};
  }
  const runtimeBackendMap: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const trimmedEntry = entry.trim();
    if (!trimmedEntry) {
      continue;
    }
    const separatorIndex = trimmedEntry.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const backend = trimmedEntry.slice(0, separatorIndex).trim().toLowerCase();
    const runtimeBackend = trimmedEntry.slice(separatorIndex + 1).trim().toLowerCase();
    if (!backend || !runtimeBackend) {
      continue;
    }
    runtimeBackendMap[backend] = runtimeBackend;
  }
  return runtimeBackendMap;
};

const extractCapabilities = (req: IncomingMessage): string[] => {
  const header = req.headers["x-conductor-capabilities"];
  const value = Array.isArray(header) ? header[0] : (header as string | undefined);
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
};

const extractVersion = (req: IncomingMessage): string | undefined => {
  const header = req.headers["x-conductor-version"];
  return Array.isArray(header) ? header[0] : (header as string | undefined);
};

const handleTerminalOpenedEvent = async (args: {
  userId: string;
  agentHost: string;
  payload: Extract<AgentEvent, { type: "terminal_opened" }>["payload"];
}) => {
  const taskId = normalizeOptionalString(args.payload.task_id);
  if (!taskId) {
    throw new Error("terminal_opened requires task_id");
  }

  const task = await getOwnedPtyTask(args.userId, taskId);
  if (!task || !task.ptySession) {
    return;
  }

  await ensureAgentOwnsTask(args.userId, task, args.agentHost);
  const startedAt =
    task.ptySession.startedAt?.toISOString() ||
    normalizeIsoDate(args.payload.started_at, new Date().toISOString());
  await db.$transaction([
    db.task.update({
      where: { id: task.id },
      data: { status: "running", executionHost: args.agentHost },
    }),
    db.ptySession.update({
      where: { taskId: task.id },
      data: {
        state: "running",
        pid: normalizePositiveInt(args.payload.pid),
        cwd: normalizeOptionalString(args.payload.cwd),
        shell: normalizeOptionalString(args.payload.shell),
        cols: normalizePositiveInt(args.payload.cols),
        rows: normalizePositiveInt(args.payload.rows),
        ...(task.ptySession.startedAt ? {} : { startedAt: new Date(startedAt) }),
        closedAt: null,
      },
    }),
  ]);

  broadcastTaskStatusUpdate(args.userId, task.projectId, task.id, "running");
  realtimeHub.broadcastTerminal(args.userId, task.id, {
    type: "terminal_opened",
    payload: {
      task_id: task.id,
      project_id: task.projectId,
      pty_session_id: task.ptySession.id,
      pid: normalizePositiveInt(args.payload.pid),
      cwd: normalizeOptionalString(args.payload.cwd) || undefined,
      shell: normalizeOptionalString(args.payload.shell) || undefined,
      cols: normalizePositiveInt(args.payload.cols) ?? undefined,
      rows: normalizePositiveInt(args.payload.rows) ?? undefined,
      started_at: startedAt,
    },
  });
};

export const handleTerminalOutputEvent = async (args: {
  userId: string;
  agentHost: string;
  payload: Extract<AgentEvent, { type: "terminal_output" }>["payload"];
}) => {
  const taskId = normalizeOptionalString(args.payload.task_id);
  const data = typeof args.payload.data === "string" ? args.payload.data : "";
  const latencySample = normalizeTerminalLatencySample(args.payload.latency_sample);
  if (!taskId || !data) {
    return;
  }

  const boundHost = realtimeHub.getTaskAgentHost(taskId);
  if (boundHost && boundHost !== args.agentHost) {
    console.warn(
      `[agent-gateway] dropped terminal_output from ${args.agentHost} for ${taskId}: owner=${boundHost}`,
    );
    return;
  }
  if (!boundHost) {
    let task;
    try {
      task = await db.task.findFirst({
        where: {
          id: taskId,
          taskType: "pty_task",
          project: { userId: args.userId },
        },
        select: {
          id: true,
          agentHost: true,
          executionHost: true,
        },
      });
    } catch (error) {
      if (!isMissingPtySchemaError(error)) {
        throw error;
      }
      task = null;
    }
    if (!task) {
      console.warn(
        `[agent-gateway] dropped terminal_output from ${args.agentHost} for ${taskId}: task not found`,
      );
      return;
    }
    try {
      await ensureAgentOwnsTask(args.userId, task, args.agentHost);
    } catch (error) {
      console.warn(
        `[agent-gateway] dropped terminal_output from ${args.agentHost} for ${taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
  }

  realtimeHub.broadcastTerminal(args.userId, taskId, {
    type: "terminal_output",
    payload: {
      task_id: taskId,
      project_id: normalizeOptionalString(args.payload.project_id) || undefined,
      pty_session_id: normalizeOptionalString(args.payload.pty_session_id) || undefined,
      seq: normalizeNonNegativeInt(args.payload.seq) ?? undefined,
      data,
      latency_sample: latencySample,
    },
  });
  if (latencySample) {
    realtimeHub.recordTerminalLatencySample(taskId, latencySample);
  }
};

export const handleTerminalSnapshotEvent = async (args: {
  userId: string;
  agentHost: string;
  payload: Extract<AgentEvent, { type: "terminal_snapshot" }>["payload"];
}) => {
  const taskId = normalizeOptionalString(args.payload.task_id);
  if (!taskId) {
    return;
  }

  const boundHost = realtimeHub.getTaskAgentHost(taskId);
  if (boundHost && boundHost !== args.agentHost) {
    console.warn(
      `[agent-gateway] dropped terminal_snapshot from ${args.agentHost} for ${taskId}: owner=${boundHost}`,
    );
    return;
  }
  if (!boundHost) {
    let task;
    try {
      task = await db.task.findFirst({
        where: {
          id: taskId,
          taskType: "pty_task",
          project: { userId: args.userId },
        },
        select: {
          id: true,
          agentHost: true,
          executionHost: true,
        },
      });
    } catch (error) {
      if (!isMissingPtySchemaError(error)) {
        throw error;
      }
      task = null;
    }
    if (!task) {
      console.warn(
        `[agent-gateway] dropped terminal_snapshot from ${args.agentHost} for ${taskId}: task not found`,
      );
      return;
    }
    try {
      await ensureAgentOwnsTask(args.userId, task, args.agentHost);
    } catch (error) {
      console.warn(
        `[agent-gateway] dropped terminal_snapshot from ${args.agentHost} for ${taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
  }

  const envelope = {
    type: "terminal_snapshot",
    payload: {
      task_id: taskId,
      project_id: normalizeOptionalString(args.payload.project_id) || undefined,
      pty_session_id: normalizeOptionalString(args.payload.pty_session_id) || undefined,
      last_seq: normalizeNonNegativeInt(args.payload.last_seq) ?? undefined,
      data: typeof args.payload.data === "string" ? args.payload.data : "",
      truncated: args.payload.truncated === true,
    },
  };
  const connectionId = normalizeOptionalString(args.payload.connection_id);
  if (connectionId) {
    if (!realtimeHub.isTerminalAttached(connectionId, taskId)) {
      return;
    }
    realtimeHub.sendToConnection(connectionId, envelope);
    return;
  }

  realtimeHub.broadcastTerminal(args.userId, taskId, envelope);
};

export const handleTerminalExitEvent = async (args: {
  userId: string;
  agentHost: string;
  payload: Extract<AgentEvent, { type: "terminal_exit" }>["payload"];
}) => {
  const taskId = normalizeOptionalString(args.payload.task_id);
  if (!taskId) {
    throw new Error("terminal_exit requires task_id");
  }

  const task = await getOwnedPtyTask(args.userId, taskId);
  if (!task || !task.ptySession) {
    return;
  }

  await ensureAgentOwnsTask(args.userId, task, args.agentHost);
  const exitCode = normalizeNonNegativeInt(args.payload.exit_code);
  const signal = normalizeExitSignal(args.payload.signal);
  const status = normalizePtyTaskStatus(exitCode, signal);
  const closedAt = normalizeIsoDate(args.payload.closed_at, new Date().toISOString());
  const seq = normalizeNonNegativeInt(args.payload.seq);
  await db.$transaction([
    db.task.update({
      where: { id: task.id },
      data: { status, executionHost: args.agentHost },
    }),
    db.ptySession.update({
      where: { taskId: task.id },
      data: {
        state: "exited",
        closedAt: new Date(closedAt),
        ...(seq !== null ? { lastOutputSeq: seq } : {}),
      },
    }),
  ]);

  broadcastTaskStatusUpdate(args.userId, task.projectId, task.id, status);
  realtimeHub.broadcastTerminal(args.userId, task.id, {
    type: "terminal_exit",
    payload: {
      task_id: task.id,
      project_id: task.projectId,
      pty_session_id: task.ptySession.id,
      exit_code: exitCode,
      signal: signal ?? undefined,
      seq: seq ?? undefined,
      closed_at: closedAt,
    },
  });
};

export const handleTerminalErrorEvent = async (args: {
  userId: string;
  agentHost: string;
  payload: Extract<AgentEvent, { type: "terminal_error" }>["payload"];
}) => {
  const taskId = normalizeOptionalString(args.payload.task_id);
  if (!taskId) {
    throw new Error("terminal_error requires task_id");
  }

  const task = await getOwnedPtyTask(args.userId, taskId);
  if (!task || !task.ptySession) {
    return;
  }

  await ensureAgentOwnsTask(args.userId, task, args.agentHost);
  const message = normalizeOptionalString(args.payload.message) || "terminal error";
  const closedAt = new Date().toISOString();
  const currentTaskStatus = normalizeTaskStatus(task.status);
  const taskWasActive = currentTaskStatus === "init" || currentTaskStatus === "running" || currentTaskStatus === "unknown";
  const latestStatusSummary = normalizeOptionalString(task.taskStatusEvents?.[0]?.summary);
  const shouldCreateStatusEvent = taskWasActive && latestStatusSummary !== message;

  const writes = [];
  if (shouldCreateStatusEvent) {
    writes.push(
      db.taskStatusEvent.create({
        data: {
          taskId: task.id,
          statusEventId: randomUUID(),
          status: "killed",
          summary: message,
        },
      }),
    );
  }
  if (taskWasActive) {
    writes.push(
      db.task.update({
        where: { id: task.id },
        data: { status: "killed", executionHost: args.agentHost },
      }),
    );
    writes.push(
      db.ptySession.update({
        where: { taskId: task.id },
        data: {
          state: "failed",
          closedAt: new Date(closedAt),
        },
      }),
    );
  }
  if (writes.length > 0) {
    await db.$transaction(writes);
  }

  if (taskWasActive) {
    broadcastTaskStatusUpdate(args.userId, task.projectId, task.id, "killed", message);
  }
  realtimeHub.broadcastTerminal(args.userId, task.id, {
    type: "terminal_error",
    payload: {
      task_id: task.id,
      project_id: task.projectId,
      pty_session_id: task.ptySession.id,
      message,
      closed_at: closedAt,
    },
  });
};

const ensureAgentOwnsPtyTaskForTransportEvent = async (
  userId: string,
  agentHost: string,
  taskId: string,
): Promise<boolean> => {
  const boundHost = realtimeHub.getTaskAgentHost(taskId);
  if (boundHost) {
    return boundHost === agentHost;
  }

  let task;
  try {
    task = await db.task.findFirst({
      where: {
        id: taskId,
        taskType: "pty_task",
        project: { userId },
      },
      select: {
        id: true,
        agentHost: true,
        executionHost: true,
      },
    });
  } catch (error) {
    if (!isMissingPtySchemaError(error)) {
      throw error;
    }
    task = null;
  }
  if (!task) {
    return false;
  }

  try {
    await ensureAgentOwnsTask(userId, task, agentHost);
    return true;
  } catch {
    return false;
  }
};

export const handlePtyTransportStatusEvent = async (args: {
  userId: string;
  agentHost: string;
  payload: Extract<AgentEvent, { type: "pty_transport_status" }>["payload"];
}) => {
  const taskId = normalizeOptionalString(args.payload.task_id);
  const sessionId = normalizeOptionalString(args.payload.session_id);
  const connectionId = normalizeOptionalString(args.payload.connection_id);
  if (!taskId || !sessionId || !connectionId) {
    return;
  }
  if (!(await ensureAgentOwnsPtyTaskForTransportEvent(args.userId, args.agentHost, taskId))) {
    return;
  }
  if (!realtimeHub.isTerminalAttached(connectionId, taskId)) {
    return;
  }

  realtimeHub.sendToConnection(connectionId, {
    type: "pty_transport_status",
    payload: {
      task_id: taskId,
      session_id: sessionId,
      transport_state: normalizeOptionalString(args.payload.transport_state) || "fallback_relay",
      transport_policy: normalizeOptionalString(args.payload.transport_policy) || undefined,
      writer_connection_id: normalizeOptionalString(args.payload.writer_connection_id) || undefined,
      direct_candidate: args.payload.direct_candidate === true,
      reason: normalizeOptionalString(args.payload.reason) || undefined,
    },
  });
};

export const handlePtyTransportSignalEvent = async (args: {
  userId: string;
  agentHost: string;
  payload: Extract<AgentEvent, { type: "pty_transport_signal" }>["payload"];
}) => {
  const taskId = normalizeOptionalString(args.payload.task_id);
  const sessionId = normalizeOptionalString(args.payload.session_id);
  const connectionId = normalizeOptionalString(args.payload.connection_id);
  const signalType = normalizeOptionalString(args.payload.signal_type);
  if (!taskId || !sessionId || !connectionId || !signalType) {
    return;
  }
  if (!(await ensureAgentOwnsPtyTaskForTransportEvent(args.userId, args.agentHost, taskId))) {
    return;
  }
  if (!realtimeHub.isTerminalAttached(connectionId, taskId)) {
    return;
  }

  realtimeHub.sendToConnection(connectionId, {
    type: "pty_transport_signal",
    payload: {
      task_id: taskId,
      session_id: sessionId,
      signal_type: signalType,
      ...(args.payload.description ? { description: args.payload.description } : {}),
      ...(args.payload.candidate ? { candidate: args.payload.candidate } : {}),
    },
  });
};

export const setupAgentGateway = (): WebSocketServer => {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", async (socket, request) => {
    const token = extractToken(request);
    if (!token) {
      sendEnvelope(socket, { type: "error", payload: { message: "Token required" } });
      socket.close(4001, "token-required");
      return;
    }

    const user = await authenticateToken(token);
    if (!user) {
      sendEnvelope(socket, { type: "error", payload: { message: "Invalid token" } });
      socket.close(4002, "invalid-token");
      return;
    }

    const connectionId = randomUUID();
    const agentHost = extractHost(request) || request.socket.remoteAddress || "unknown-host";
    const supportedBackends = extractSupportedBackends(request);
    const runtimeBackendMap = extractRuntimeBackendMap(request);
    const capabilities = extractCapabilities(request);
    const version = extractVersion(request);

    if (realtimeHub.hasAgentHost(agentHost, user.id)) {
      const replacedCount = realtimeHub.takeOverAgentHost(agentHost, user.id);
      console.warn(
        `[agent-gateway] taking over existing agent host connection: userId=${user.id}, agentHost=${agentHost}, replaced=${replacedCount}`,
      );
    }

    const userExists = await db.user.findUnique({
      where: { id: user.id },
      select: { id: true },
    });
    if (!userExists) {
      sendEnvelope(socket, { type: "error", payload: { message: "Invalid token" } });
      socket.close(4002, "invalid-token");
      return;
    }

    realtimeHub.register({
      id: connectionId,
      kind: "agent",
      userId: user.id,
      projectIds: ["*"],
      host: agentHost,
      supportedBackends,
      runtimeBackendMap,
      capabilities,
      version,
      send: (payload) => sendEnvelope(socket, payload as Record<string, unknown>),
      close: () => socket.close(),
    });

    console.log(`[agent-gateway] Agent connected: userId=${user.id}, agentHost=${agentHost}, backends=${supportedBackends.join(",")}, capabilities=${capabilities.join(",")}, version=${version || "unknown"}, connectionId=${connectionId}`);
    void drainAgentOutboxForHost(user.id, agentHost, {
      ignoreRetryAt: true,
    });

    socket.on("message", async (raw) => {
      try {
        const event = JSON.parse(raw.toString()) as AgentEvent;
        realtimeHub.heartbeat(connectionId);
        switch (event.type) {
          case "create_task": {
            let task;
            try {
              task = await db.task.create({
                data: {
                  id: event.payload.task_id,
                  projectId: event.payload.project_id,
                  title: event.payload.title,
                  agentHost,
                  executionHost: agentHost,
                },
                select: { ...taskSelectWithoutIssueId },
              });
            } catch (error) {
              if (!isMissingAnyNewSchemaError(error)) throw error;
              // Legacy schema lacks taskType/launchConfig columns — use narrower select.
              // Downstream only reads task.id and task.projectId, so the missing fields are safe.
              task = await db.task.create({
                data: {
                  id: event.payload.task_id,
                  projectId: event.payload.project_id,
                  title: event.payload.title,
                  agentHost,
                  executionHost: agentHost,
                },
                select: { ...legacyTaskSelect, title: true },
              });
            }
            if (event.payload.prefill) {
              const [message] = await db.$transaction([
                db.message.create({
                  data: { taskId: task.id, role: "user", content: event.payload.prefill },
                }),
                db.task.update({
                  where: { id: task.id },
                  data: { updatedAt: new Date() },
                }),
              ]);
              realtimeHub.broadcast(user.id, task.projectId, {
                type: "task_user_message",
                payload: {
                  id: message.id,
                  task_id: task.id,
                  project_id: task.projectId,
                  role: "user",
                  content: message.content,
                  created_at: message.createdAt.toISOString(),
                },
              });
            }
            realtimeHub.bindTaskToAgent(task.id, agentHost);
            sendEnvelope(socket, { type: "task_created", payload: { task_id: task.id } });
            break;
          }
          case "sdk_message": {
            // Narrow select avoids hitting missing issueId/taskType columns.
            // Only task.id is used here — commitSdkMessage re-fetches the full task.
            const task = await db.task.findFirst({
              where: { id: event.payload.task_id, project: { userId: user.id } },
              select: { id: true },
            });
            if (!task) {
              sendEnvelope(socket, { type: "error", payload: { message: `Task ${event.payload.task_id} not found` } });
              break;
            }
            try {
              await commitSdkMessage({
                userId: user.id,
                agentHost,
                taskId: task.id,
                content: event.payload.content,
                metadata: event.payload.metadata,
                messageId: event.payload.message_id,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendEnvelope(socket, { type: "error", payload: { message } });
            }
            break;
          }
          case "task_status_update": {
            const taskId = event.payload.task_id;
            const status = normalizeTaskStatus(event.payload.status);
            if (!taskId) {
              sendEnvelope(socket, { type: "error", payload: { message: "task_status_update requires task_id and status" } });
              break;
            }
            // Narrow select avoids hitting missing issueId/taskType columns.
            // Only task.id and task.projectId are used — commitTaskStatusUpdate re-fetches via getOwnedTask.
            const task = await db.task.findFirst({
              where: { id: taskId, project: { userId: user.id } },
              select: { id: true, projectId: true },
            });
            if (!task) {
              sendEnvelope(socket, { type: "error", payload: { message: `Task ${taskId} not found` } });
              break;
            }
            try {
              const result = await commitTaskStatusUpdate({
                userId: user.id,
                agentHost,
                taskId,
                status,
                summary: event.payload.summary,
              });
              sendEnvelope(socket, {
                type: "status_recorded",
                payload: { task_id: result.taskId, status: result.status },
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendEnvelope(socket, { type: "error", payload: { message } });
            }
            break;
          }
          case "task_stop_ack": {
            const taskId = event.payload.task_id;
            const requestId = event.payload.request_id;
            if (!taskId || !requestId) {
              sendEnvelope(socket, { type: "error", payload: { message: "task_stop_ack requires task_id and request_id" } });
              break;
            }
            await commitTaskStopAck({
              userId: user.id,
              agentHost,
              taskId,
              requestId,
              accepted: event.payload.accepted !== false,
            });
            sendEnvelope(socket, {
              type: "task_stop_ack_recorded",
              payload: { task_id: taskId, request_id: requestId, accepted: event.payload.accepted !== false },
            });
            break;
          }
          case "agent_command_ack": {
            const requestId = event.payload.request_id ? String(event.payload.request_id) : "";
            if (!requestId) {
              sendEnvelope(socket, { type: "error", payload: { message: "agent_command_ack requires request_id" } });
              break;
            }
            await commitAgentCommandAck({
              userId: user.id,
              agentHost,
              requestId,
              accepted: event.payload.accepted !== false,
              eventType: event.payload.event_type,
              taskId: event.payload.task_id,
            });
            break;
          }
          case "agent_resume": {
            const { boundCount, source } = await processAgentResume({
              userId: user.id,
              agentHost,
              payload: event.payload,
            });
            sendEnvelope(socket, {
              type: "agent_resume_recorded",
              payload: {
                active_task_count: boundCount,
                source,
              },
            });
            break;
          }
          case "agent_log_collected": {
            const requestId = normalizeOptionalString(event.payload.request_id);
            const taskId = normalizeOptionalString(event.payload.task_id);
            if (!requestId || !taskId) {
              sendEnvelope(socket, { type: "error", payload: { message: "agent_log_collected requires request_id and task_id" } });
              break;
            }
            realtimeHub.resolveAgentLogCollection({
              request_id: requestId,
              task_id: taskId,
              daemon_host: normalizeOptionalString(event.payload.daemon_host) || agentHost,
              project_path: normalizeOptionalString(event.payload.project_path),
              log_path: normalizeOptionalString(event.payload.log_path),
              logs: normalizeAgentLogEntries(event.payload.logs),
              truncated: Boolean(event.payload.truncated),
              error: normalizeOptionalString(event.payload.error),
              collected_at: normalizeOptionalString(event.payload.collected_at) || new Date().toISOString(),
            });
            sendEnvelope(socket, {
              type: "agent_log_collected_recorded",
              payload: { request_id: requestId, task_id: taskId },
            });
            break;
          }
          case "project_path_validated": {
            const normalized = normalizeProjectPathValidationResult(
              event.payload as Record<string, unknown>,
              agentHost,
            );
            if (!normalized) {
              sendEnvelope(socket, { type: "error", payload: { message: "project_path_validated requires request_id" } });
              break;
            }
            realtimeHub.resolveProjectPathValidation(normalized);
            break;
          }
          case "task_worktree_cleanup_result": {
            const normalized = normalizeTaskWorktreeCleanupResult(
              event.payload as Record<string, unknown>,
              agentHost,
            );
            if (!normalized) {
              sendEnvelope(socket, { type: "error", payload: { message: "task_worktree_cleanup_result requires request_id and task_id" } });
              break;
            }
            realtimeHub.resolveTaskWorktreeCleanup(normalized);
            break;
          }
          case "terminal_opened": {
            await handleTerminalOpenedEvent({
              userId: user.id,
              agentHost,
              payload: event.payload,
            });
            sendEnvelope(socket, { type: "terminal_opened_recorded", payload: { task_id: event.payload.task_id } });
            break;
          }
          case "terminal_output": {
            await handleTerminalOutputEvent({
              userId: user.id,
              agentHost,
              payload: event.payload,
            });
            break;
          }
          case "terminal_snapshot": {
            await handleTerminalSnapshotEvent({
              userId: user.id,
              agentHost,
              payload: event.payload,
            });
            break;
          }
          case "terminal_exit": {
            await handleTerminalExitEvent({
              userId: user.id,
              agentHost,
              payload: event.payload,
            });
            sendEnvelope(socket, { type: "terminal_exit_recorded", payload: { task_id: event.payload.task_id } });
            break;
          }
          case "terminal_error": {
            await handleTerminalErrorEvent({
              userId: user.id,
              agentHost,
              payload: event.payload,
            });
            sendEnvelope(socket, { type: "terminal_error_recorded", payload: { task_id: event.payload.task_id } });
            break;
          }
          case "pty_transport_status": {
            await handlePtyTransportStatusEvent({
              userId: user.id,
              agentHost,
              payload: event.payload,
            });
            break;
          }
          case "pty_transport_signal": {
            await handlePtyTransportSignalEvent({
              userId: user.id,
              agentHost,
              payload: event.payload,
            });
            break;
          }
          case "task_runtime_status": {
            const taskId = event.payload.task_id;
            if (!taskId) {
              sendEnvelope(socket, { type: "error", payload: { message: "task_runtime_status requires task_id" } });
              break;
            }
            let task;
            try {
              task = await db.task.findFirst({
                where: { id: taskId, project: { userId: user.id } },
                select: {
                  id: true, projectId: true, status: true,
                  agentHost: true, executionHost: true, taskType: true,
                },
              });
            } catch (error) {
              if (!isMissingAnyNewSchemaError(error)) throw error;
              const partial = await db.task.findFirst({
                where: { id: taskId, project: { userId: user.id } },
                select: {
                  id: true, projectId: true, status: true,
                  agentHost: true, executionHost: true,
                },
              });
              // taskType: null means fire host cannot claim this task on old schema —
              // this is intentional: old schema = old behavior (daemon-only).
              task = partial ? { ...partial, taskType: null } : null;
            }
            if (!task) {
              sendEnvelope(socket, { type: "error", payload: { message: `Task ${taskId} not found` } });
              break;
            }
            try {
              await ensureAgentOwnsTask(user.id, task, agentHost);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.warn(
                `[agent-gateway] dropped task_runtime_status from ${agentHost} for ${task.id}: ${message}`,
              );
              sendEnvelope(socket, { type: "error", payload: { message } });
              break;
            }
            if (normalizeTaskStatus(task.status) === "init") {
              try {
                await commitTaskStatusUpdate({
                  userId: user.id,
                  agentHost,
                  taskId: task.id,
                  status: "running",
                });
              } catch (error) {
                console.warn(
                  `[agent-gateway] failed to promote init task ${task.id} to running from ${agentHost}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              }
            } else {
              void drainAgentOutboxForHost(user.id, agentHost);
            }
            realtimeHub.broadcast(user.id, task.projectId, {
              type: "task_runtime_status",
              payload: {
                task_id: task.id,
                project_id: task.projectId,
                state: event.payload.state,
                phase: event.payload.phase,
                source: event.payload.source,
                reply_in_progress: event.payload.reply_in_progress,
                status_line: event.payload.status_line,
                status_done_line: event.payload.status_done_line,
                reply_preview: event.payload.reply_preview,
                reply_to: event.payload.reply_to,
                backend: event.payload.backend,
                thread_id: event.payload.thread_id,
                daemon: event.payload.daemon,
                pid: event.payload.pid,
                session_id: event.payload.session_id,
                session_file_path: event.payload.session_file_path,
                token_usage_percent: event.payload.token_usage_percent,
                context_usage_percent: event.payload.context_usage_percent,
                created_at: event.payload.created_at,
              },
            });
            sendEnvelope(socket, { type: "runtime_status_recorded", payload: { task_id: task.id } });
            break;
          }
          case "heartbeat": {
            // 可选：返回心跳确认
            sendEnvelope(socket, { type: "heartbeat_ack", payload: { timestamp: Date.now() } });
            break;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        sendEnvelope(socket, { type: "error", payload: { message } });
      }
    });

    let isAlive = true;
    socket.on("pong", () => {
      isAlive = true;
      realtimeHub.heartbeat(connectionId);
    });

    const interval = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!isAlive) {
        socket.terminate();
        return;
      }
      isAlive = false;
      socket.ping();
    }, 25_000);

    socket.on("close", () => {
      realtimeHub.unregister(connectionId);
      clearInterval(interval);
      if (!realtimeHub.hasAgentHost(agentHost, user.id)) {
        void outboxProcessor.handleDisconnectedAgent(agentHost, user.id);
      }
    });
  });

  console.log(`Agent WebSocket gateway ready at ${AGENT_WS_PATH}`);
  return wss;
};
