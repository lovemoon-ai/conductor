import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { realtimeHub } from "./hub";
import { authenticateToken } from "../auth/service";
import { randomUUID } from "crypto";
import { db } from "../db";
import { isMissingPtySchemaError } from "@/lib/tasks/pty-compat";

export const APP_WS_PATH = "/ws/app";
const ptyTransportSessionIdsByTask = new Map<string, Map<string, string>>();

const sendEnvelope = (socket: WebSocket, envelope: Record<string, unknown>) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(envelope));
};

const extractToken = (req: IncomingMessage): string | undefined => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  return url.searchParams.get("token") || undefined;
};

const normalizeTaskId = (value: unknown): string | null => {
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

const normalizeIsoTimestamp = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return Number.isNaN(Date.parse(normalized)) ? null : normalized;
};

const normalizeTerminalMode = (value: unknown): "write" | "view" => {
  if (typeof value !== "string") {
    return "write";
  }
  return value.trim().toLowerCase() === "view" ? "view" : "write";
};

const normalizeTerminalResumeStrategy = (value: unknown): "snapshot" | null => {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim().toLowerCase() === "snapshot" ? "snapshot" : null;
};

const sendTerminalError = (socket: WebSocket, taskId: string | null, message: string) => {
  sendEnvelope(socket, {
    type: "terminal_error",
    payload: {
      ...(taskId ? { task_id: taskId } : {}),
      message,
    },
  });
};

const emitTerminalAccessState = (userId: string, taskId: string) => {
  const viewerIds = realtimeHub.getTerminalSubscriberIds(taskId);
  const writerConnectionId = realtimeHub.getTerminalWriter(taskId);
  const viewerCount = realtimeHub.getTerminalViewerCount(taskId);
  for (const connectionId of viewerIds) {
    realtimeHub.sendToConnection(connectionId, {
      type: "terminal_access_updated",
      payload: {
        task_id: taskId,
        write_access: writerConnectionId === connectionId,
        writer_active: Boolean(writerConnectionId),
        viewer_count: viewerCount,
      },
    });
  }
  if (viewerIds.length > 0) {
    console.log(`[app-gateway] terminal access updated: userId=${userId}, taskId=${taskId}, viewers=${viewerCount}, writer=${writerConnectionId ?? "none"}`);
  }
};

export const shouldRevokePreviousWriterTransport = (args: {
  previousWriterConnectionId: string | null;
  nextWriterConnectionId: string | null;
  granted: boolean;
  requestedConnectionId: string;
}): boolean =>
  Boolean(
    args.granted &&
      args.previousWriterConnectionId &&
      args.previousWriterConnectionId !== args.requestedConnectionId &&
      args.nextWriterConnectionId === args.requestedConnectionId,
  );

export const shouldRefreshPtyTransportSessionOnWriterGrant = (args: {
  previousWriterConnectionId: string | null;
  nextWriterConnectionId: string | null;
  granted: boolean;
  requestedConnectionId: string;
}): boolean =>
  Boolean(
    args.granted &&
      args.nextWriterConnectionId === args.requestedConnectionId &&
      args.previousWriterConnectionId !== args.requestedConnectionId,
  );

export const deliverTerminalAttachEnvelope = (args: {
  userId: string;
  taskId: string;
  agentHost?: string | null;
  executionHost?: string | null;
  envelope: Record<string, unknown>;
}): boolean => {
  let delivered = realtimeHub.sendToAgent(args.taskId, args.envelope);
  if (!delivered) {
    const fallbackHost = args.executionHost || args.agentHost;
    if (fallbackHost && realtimeHub.hasAgentHost(fallbackHost, args.userId)) {
      realtimeHub.bindTaskToAgent(args.taskId, fallbackHost);
      delivered = realtimeHub.sendToAgentHost(args.userId, fallbackHost, args.envelope);
    }
  }
  return delivered;
};

const resolveTerminalAttachHost = (args: {
  taskId: string;
  agentHost?: string | null;
  executionHost?: string | null;
}): string | null => realtimeHub.getTaskAgentHost(args.taskId) ?? args.executionHost ?? args.agentHost ?? null;

const agentSupportsCapability = (userId: string, host: string | null, capability: string): boolean => {
  if (!host) {
    return false;
  }
  return realtimeHub
    .getAgentsForUser(userId)
    .some((agent) => agent.host === host && agent.capabilities.includes(capability));
};

export const buildForwardTerminalEnvelope = (
  type: "terminal_input" | "terminal_resize" | "terminal_detach",
  payload: Record<string, unknown>,
  taskId: string,
): Record<string, unknown> => {
  const forwardedPayload: Record<string, unknown> = {
    ...payload,
    task_id: taskId,
  };

  if (type === "terminal_input") {
    const clientSentAt = normalizeIsoTimestamp(payload.client_sent_at ?? payload.clientSentAt);
    if (clientSentAt) {
      forwardedPayload.client_sent_at = clientSentAt;
    }
    const clientInputSeq = normalizePositiveInt(payload.client_input_seq ?? payload.clientInputSeq);
    if (clientInputSeq !== null) {
      forwardedPayload.client_input_seq = clientInputSeq;
    }
    forwardedPayload.server_received_at = new Date().toISOString();
  }

  return {
    type,
    payload: forwardedPayload,
  };
};

const resolvePtyTransportPolicy = (): "relay_only" | "direct_preferred" => {
  const configured = process.env.PTY_TRANSPORT_POLICY?.trim().toLowerCase();
  return configured === "direct_preferred" || configured === "direct-preferred"
    ? "direct_preferred"
    : "relay_only";
};

export const buildPtyTransportSessionEnvelope = (args: {
  taskId: string;
  connectionId: string;
  writerConnectionId?: string | null;
  sessionId?: string;
  transportState?: "relay" | "negotiating" | "direct" | "fallback_relay";
}): Record<string, unknown> => {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 30_000);
  const transportPolicy = resolvePtyTransportPolicy();
  const writerConnectionId = args.writerConnectionId ?? null;
  return {
    type: "pty_transport_session",
    payload: {
      task_id: args.taskId,
      session_id: args.sessionId ?? randomUUID(),
      transport_policy: transportPolicy,
      writer_connection_id: writerConnectionId,
      ...(args.transportState ? { transport_state: args.transportState } : {}),
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      direct_candidate: transportPolicy === "direct_preferred" && writerConnectionId === args.connectionId,
    },
  };
};

export const buildForwardPtyTransportSignalEnvelope = (
  payload: Record<string, unknown>,
  taskId: string,
  connectionId: string,
): Record<string, unknown> => ({
  type: "pty_transport_signal",
  payload: {
    ...payload,
    task_id: taskId,
    connection_id: connectionId,
  },
});

const getOrCreatePtyTransportSessionId = (taskId: string, connectionId: string): string => {
  const byConnection = ptyTransportSessionIdsByTask.get(taskId) ?? new Map<string, string>();
  const existing = byConnection.get(connectionId);
  if (existing) {
    if (!ptyTransportSessionIdsByTask.has(taskId)) {
      ptyTransportSessionIdsByTask.set(taskId, byConnection);
    }
    return existing;
  }
  const sessionId = randomUUID();
  byConnection.set(connectionId, sessionId);
  ptyTransportSessionIdsByTask.set(taskId, byConnection);
  return sessionId;
};

const refreshPtyTransportSessionId = (taskId: string, connectionId: string): string => {
  const byConnection = ptyTransportSessionIdsByTask.get(taskId) ?? new Map<string, string>();
  const sessionId = randomUUID();
  byConnection.set(connectionId, sessionId);
  ptyTransportSessionIdsByTask.set(taskId, byConnection);
  return sessionId;
};

const clearPtyTransportSessionIds = (taskId: string, connectionId?: string) => {
  const byConnection = ptyTransportSessionIdsByTask.get(taskId);
  if (!byConnection) {
    return;
  }
  if (!connectionId) {
    ptyTransportSessionIdsByTask.delete(taskId);
    return;
  }
  byConnection.delete(connectionId);
  if (byConnection.size === 0) {
    ptyTransportSessionIdsByTask.delete(taskId);
  }
};

const emitPtyTransportSessions = (
  taskId: string,
  options?: {
    resetConnectionIds?: string[];
  },
) => {
  const viewerIds = realtimeHub.getTerminalSubscriberIds(taskId);
  const viewerIdSet = new Set(viewerIds);
  const resetConnectionIds = new Set(options?.resetConnectionIds ?? []);
  const existing = ptyTransportSessionIdsByTask.get(taskId);
  if (existing) {
    for (const connectionId of existing.keys()) {
      if (!viewerIdSet.has(connectionId)) {
        existing.delete(connectionId);
      }
    }
    if (existing.size === 0) {
      ptyTransportSessionIdsByTask.delete(taskId);
    }
  }
  const writerConnectionId = realtimeHub.getTerminalWriter(taskId);
  for (const connectionId of viewerIds) {
    const sessionId = resetConnectionIds.has(connectionId)
      ? refreshPtyTransportSessionId(taskId, connectionId)
      : getOrCreatePtyTransportSessionId(taskId, connectionId);
    realtimeHub.sendToConnection(
      connectionId,
      buildPtyTransportSessionEnvelope({
        taskId,
        connectionId,
        writerConnectionId,
        sessionId,
        transportState: resetConnectionIds.has(connectionId) ? "relay" : undefined,
      }),
    );
  }
};

const revokePtyDirectTransport = (taskId: string, connectionId: string, reason: string) => {
  realtimeHub.sendToAgent(taskId, {
    type: "pty_transport_signal",
    payload: {
      task_id: taskId,
      connection_id: connectionId,
      signal_type: "revoke",
      reason,
    },
  });
};

export const setupAppGateway = (): WebSocketServer => {
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
    realtimeHub.register({
      id: connectionId,
      kind: "app",
      userId: user.id,
      projectIds: ["*"],
      send: (payload) => sendEnvelope(socket, payload as Record<string, unknown>),
      close: () => socket.close(),
    });
    console.log(`[app-gateway] App connected: userId=${user.id}, connectionId=${connectionId}`);

    socket.on("message", async (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === "subscribe" && data.payload?.projectIds) {
          realtimeHub.updateProjectIds(connectionId, data.payload.projectIds);
          return;
        }

        if (data.type === "terminal_attach") {
          const taskId = normalizeTaskId(data.payload?.task_id ?? data.payload?.taskId);
          if (!taskId) {
            sendEnvelope(socket, { type: "error", payload: { message: "terminal_attach requires task_id" } });
            return;
          }

          let task = null;
          try {
            task = await db.task.findFirst({
              where: { id: taskId, project: { userId: user.id } },
              select: {
                id: true,
                projectId: true,
                taskType: true,
                agentHost: true,
                executionHost: true,
                ptySession: { select: { id: true } },
              },
            });
          } catch (error) {
            if (!isMissingPtySchemaError(error)) {
              throw error;
            }
          }
          if (!task || task.taskType !== "pty_task" || !task.ptySession) {
            sendTerminalError(socket, taskId, `PTY task ${taskId} not found`);
            return;
          }

          realtimeHub.attachTerminal(connectionId, task.id);
          const requestedMode = normalizeTerminalMode(
            data.payload?.mode ?? data.payload?.preferred_mode ?? data.payload?.preferredMode,
          );
          const previousWriterConnectionId = realtimeHub.getTerminalWriter(task.id);
          let resetWriterTransportSession = false;
          if (requestedMode === "write") {
            const writerRequest = realtimeHub.requestTerminalWriter(task.id, connectionId, {
              force: data.payload?.force === true,
            });
            resetWriterTransportSession = shouldRefreshPtyTransportSessionOnWriterGrant({
              previousWriterConnectionId,
              nextWriterConnectionId: writerRequest.writerConnectionId,
              granted: writerRequest.granted,
              requestedConnectionId: connectionId,
            });
            if (
              previousWriterConnectionId &&
              shouldRevokePreviousWriterTransport({
                previousWriterConnectionId,
                nextWriterConnectionId: writerRequest.writerConnectionId,
                granted: writerRequest.granted,
                requestedConnectionId: connectionId,
              })
            ) {
              revokePtyDirectTransport(task.id, previousWriterConnectionId, "writer_taken_over");
            }
          } else {
            realtimeHub.releaseTerminalWriter(task.id, connectionId);
          }
          const lastSeq = normalizePositiveInt(data.payload?.last_seq ?? data.payload?.lastSeq) ?? 0;
          const requestedResumeStrategy = normalizeTerminalResumeStrategy(
            data.payload?.resume_strategy ?? data.payload?.resumeStrategy,
          );
          const attachHost = resolveTerminalAttachHost({
            taskId: task.id,
            agentHost: task.agentHost,
            executionHost: task.executionHost,
          });
          const useSnapshotResume =
            lastSeq === 0 &&
            requestedResumeStrategy === "snapshot" &&
            agentSupportsCapability(user.id, attachHost, "terminal_snapshot");
          const envelope = {
            type: "terminal_attach",
            payload: {
              task_id: task.id,
              project_id: task.projectId,
              pty_session_id: task.ptySession.id,
              last_seq: lastSeq,
              cols: normalizePositiveInt(data.payload?.cols),
              rows: normalizePositiveInt(data.payload?.rows),
              ...(useSnapshotResume
                ? {
                    connection_id: connectionId,
                    resume_strategy: "snapshot",
                  }
                : {}),
            },
          };
          const delivered = deliverTerminalAttachEnvelope({
            userId: user.id,
            taskId: task.id,
            agentHost: task.agentHost,
            executionHost: task.executionHost,
            envelope,
          });
          if (!delivered) {
            realtimeHub.detachTerminal(connectionId, task.id);
            clearPtyTransportSessionIds(task.id, connectionId);
            emitPtyTransportSessions(task.id);
            emitTerminalAccessState(user.id, task.id);
            sendTerminalError(socket, taskId, `Agent for PTY task ${taskId} is offline`);
            return;
          }
          emitPtyTransportSessions(task.id, {
            resetConnectionIds: resetWriterTransportSession ? [connectionId] : [],
          });
          emitTerminalAccessState(user.id, task.id);
          return;
        }

        if (data.type === "terminal_set_mode") {
          const taskId = normalizeTaskId(data.payload?.task_id ?? data.payload?.taskId);
          if (!taskId) {
            sendEnvelope(socket, { type: "error", payload: { message: "terminal_set_mode requires task_id" } });
            return;
          }
          if (!realtimeHub.isTerminalAttached(connectionId, taskId)) {
            sendTerminalError(socket, taskId, `terminal ${taskId} is not attached`);
            return;
          }

          const mode = normalizeTerminalMode(data.payload?.mode);
          let resetWriterTransportSession = false;
          if (mode === "write") {
            const previousWriterConnectionId = realtimeHub.getTerminalWriter(taskId);
            const writerRequest = realtimeHub.requestTerminalWriter(taskId, connectionId, {
              force: data.payload?.force === true,
            });
            resetWriterTransportSession = shouldRefreshPtyTransportSessionOnWriterGrant({
              previousWriterConnectionId,
              nextWriterConnectionId: writerRequest.writerConnectionId,
              granted: writerRequest.granted,
              requestedConnectionId: connectionId,
            });
            if (
              previousWriterConnectionId &&
              shouldRevokePreviousWriterTransport({
                previousWriterConnectionId,
                nextWriterConnectionId: writerRequest.writerConnectionId,
                granted: writerRequest.granted,
                requestedConnectionId: connectionId,
              })
            ) {
              revokePtyDirectTransport(taskId, previousWriterConnectionId, "writer_taken_over");
            }
          } else {
            const released = realtimeHub.releaseTerminalWriter(taskId, connectionId);
            if (released) {
              revokePtyDirectTransport(taskId, connectionId, "writer_released");
            }
          }
          emitPtyTransportSessions(taskId, {
            resetConnectionIds: resetWriterTransportSession ? [connectionId] : [],
          });
          emitTerminalAccessState(user.id, taskId);
          return;
        }

        if (data.type === "pty_transport_signal") {
          const taskId = normalizeTaskId(data.payload?.task_id ?? data.payload?.taskId);
          const sessionId = normalizeTaskId(data.payload?.session_id ?? data.payload?.sessionId);
          if (!taskId || !sessionId) {
            sendEnvelope(socket, { type: "error", payload: { message: "pty_transport_signal requires task_id and session_id" } });
            return;
          }
          if (!realtimeHub.isTerminalAttached(connectionId, taskId)) {
            sendTerminalError(socket, taskId, `terminal ${taskId} is not attached`);
            return;
          }
          if (!realtimeHub.isTerminalWriter(taskId, connectionId)) {
            emitTerminalAccessState(user.id, taskId);
            emitPtyTransportSessions(taskId);
            return;
          }

          const delivered = realtimeHub.sendToAgent(
            taskId,
            buildForwardPtyTransportSignalEnvelope(data.payload, taskId, connectionId),
          );
          if (!delivered) {
            sendEnvelope(socket, {
              type: "pty_transport_status",
              payload: {
                task_id: taskId,
                session_id: sessionId,
                transport_state: "fallback_relay",
                transport_policy: resolvePtyTransportPolicy(),
                writer_connection_id: connectionId,
                direct_candidate: false,
                reason: "agent_offline",
              },
            });
          }
          return;
        }

        if (data.type === "terminal_input" || data.type === "terminal_resize" || data.type === "terminal_detach") {
          const taskId = normalizeTaskId(data.payload?.task_id ?? data.payload?.taskId);
          if (!taskId) {
            sendEnvelope(socket, { type: "error", payload: { message: `${data.type} requires task_id` } });
            return;
          }
          if (!realtimeHub.isTerminalAttached(connectionId, taskId)) {
            sendTerminalError(socket, taskId, `terminal ${taskId} is not attached`);
            return;
          }

          if (data.type === "terminal_detach") {
            const result = realtimeHub.detachTerminal(connectionId, taskId);
            clearPtyTransportSessionIds(taskId, connectionId);
            if (result.releasedWriterTaskIds.includes(taskId)) {
              revokePtyDirectTransport(taskId, connectionId, "writer_detached");
            }
            emitPtyTransportSessions(taskId);
            emitTerminalAccessState(user.id, taskId);
          } else if (!realtimeHub.isTerminalWriter(taskId, connectionId)) {
            emitTerminalAccessState(user.id, taskId);
            return;
          }

          const delivered = realtimeHub.sendToAgent(taskId, buildForwardTerminalEnvelope(data.type, data.payload, taskId));
          if (!delivered && data.type !== "terminal_detach") {
            sendTerminalError(socket, taskId, `Agent for PTY task ${taskId} is offline`);
          }
        }
      } catch {}
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
      const unregisterResult = realtimeHub.unregister(connectionId);
      for (const taskId of unregisterResult.detachedTaskIds) {
        clearPtyTransportSessionIds(taskId, connectionId);
        if (unregisterResult.releasedWriterTaskIds.includes(taskId)) {
          revokePtyDirectTransport(taskId, connectionId, "writer_disconnected");
        }
        emitPtyTransportSessions(taskId);
        emitTerminalAccessState(user.id, taskId);
      }
      clearInterval(interval);
    });
  });

  console.log(`App WebSocket gateway ready at ${APP_WS_PATH}`);
  return wss;
};
