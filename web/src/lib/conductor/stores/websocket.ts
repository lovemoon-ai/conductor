import { create } from 'zustand';
import type { WSConnectionStatus, Message, TaskStatus, TaskRuntimeStatus } from '@/shared/types';
import { getMessageAttachments } from '@/shared/utils/message-attachments';
import { useChatStore } from './chat';
import { useTasksStore } from './tasks';
import { useRuntimeStore } from './runtime';
import { useTerminalStore } from './terminal';

interface WebSocketState {
  status: WSConnectionStatus;
  ws: WebSocket | null;
  reconnectAttempts: number;

  // Actions
  connect: (userToken: string) => void;
  disconnect: () => void;
  send: (data: unknown) => void;
}

const RECONNECT_DELAY = 5000;
const MAX_RECONNECT_ATTEMPTS = 10;

const normalizeConfiguredAppWebSocketUrl = (
  value: string | undefined,
  locationLike: Pick<Location, 'protocol' | 'host'>,
): string | null => {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const parsed = new URL(value, `${locationLike.protocol}//${locationLike.host}`);
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'ws:';
    } else if (parsed.protocol === 'https:') {
      parsed.protocol = 'wss:';
    } else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return null;
    }

    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/ws/app';
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

export const resolveAppWebSocketUrl = (
  userToken: string,
  locationLike: Pick<Location, 'protocol' | 'host'> = window.location,
): string => {
  const configuredUrl = normalizeConfiguredAppWebSocketUrl(process.env.NEXT_PUBLIC_APP_WS_URL, locationLike);

  const target = new URL(
    configuredUrl || `${locationLike.protocol === 'https:' ? 'wss:' : 'ws:'}//${locationLike.host}/ws/app`,
  );
  target.searchParams.set('token', userToken);
  return target.toString();
};

export const useWebSocketStore = create<WebSocketState>()((set, get) => ({
  status: 'disconnected',
  ws: null,
  reconnectAttempts: 0,

  connect: (userToken) => {
    const { ws, status } = get();

    // Already connected or connecting
    if (ws && (status === 'connected' || status === 'connecting')) {
      return;
    }

    const wsUrl = resolveAppWebSocketUrl(userToken);

    const socket = new WebSocket(wsUrl);
    set({ status: 'connecting', ws: socket });

    socket.onopen = () => {
      if (get().ws !== socket) {
        socket.close();
        return;
      }
      useChatStore.getState().invalidateHydratedTasks();
      set({ status: 'connected', ws: socket, reconnectAttempts: 0 });
    };

    socket.onclose = () => {
      if (get().ws !== socket) {
        return;
      }
      set({ status: 'disconnected', ws: null });
      useTerminalStore.getState().markSocketDisconnected();

      // Auto-reconnect
      const { reconnectAttempts } = get();
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        setTimeout(() => {
          set({ reconnectAttempts: reconnectAttempts + 1 });
          get().connect(userToken);
        }, RECONNECT_DELAY);
      }
    };

    socket.onerror = () => {
      // Error will trigger onclose
    };

    socket.onmessage = (event) => {
      if (get().ws !== socket) {
        return;
      }
      try {
        const data = JSON.parse(event.data);
        handleWSMessage(data);
      } catch (e) {
        console.error('[ws] onmessage error:', e);
      }
    };
  },

  disconnect: () => {
    const { ws } = get();
    if (ws) {
      set({ ws: null, status: 'disconnected', reconnectAttempts: MAX_RECONNECT_ATTEMPTS });
      ws.close();
    }
    useRuntimeStore.getState().clearAll();
  },

  send: (data) => {
    const { ws, status } = get();
    if (ws && status === 'connected') {
      ws.send(JSON.stringify(data));
    }
  },
}));

function normalizeMessagePayload(payload: Record<string, unknown>): { taskId: string; message: Message } | null {
  const taskId =
    (payload.taskId as string | undefined) ||
    (payload.task_id as string | undefined);
  if (!taskId) return null;

  const messagePayload = (payload.message as Partial<Message> | undefined) ?? {};
  const id =
    (messagePayload.id as string | undefined) ||
    (payload.id as string | undefined);
  if (!id) return null;

  const role =
    (messagePayload.role as Message['role'] | undefined) ||
    (payload.role as Message['role'] | undefined) ||
    'user';
  const content =
    (messagePayload.content as string | undefined) ||
    (payload.content as string | undefined) ||
    '';
  const createdAt =
    (messagePayload.createdAt as string | undefined) ||
    (payload.createdAt as string | undefined) ||
    (payload.created_at as string | undefined);

  return {
    taskId,
    message: {
      id,
      taskId,
      role,
      content,
      createdAt,
      metadata: (messagePayload.metadata as Record<string, unknown> | null | undefined) ?? null,
      attachments:
        (messagePayload.attachments as Message["attachments"] | undefined) ||
        (payload.attachments as Message["attachments"] | undefined) ||
        getMessageAttachments(messagePayload.metadata ?? payload.metadata),
    },
  };
}

function normalizeTaskId(payload: Record<string, unknown>): string | null {
  return (payload.taskId as string | undefined) || (payload.task_id as string | undefined) || null;
}

function normalizeTaskStatus(value: unknown): TaskStatus {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'init') return 'init';
  if (normalized === 'completed') return 'completed';
  if (normalized === 'running') return 'running';
  if (normalized === 'killed' || normalized === 'failed' || normalized === 'cancelled') return 'killed';
  return 'unknown';
}

function normalizeRuntimeStatus(payload: Record<string, unknown>): TaskRuntimeStatus | null {
  const taskId = normalizeTaskId(payload);
  if (!taskId) return null;

  return {
    taskId,
    state: (payload.state as string | undefined) || undefined,
    phase: (payload.phase as string | undefined) || undefined,
    source: (payload.source as string | undefined) || undefined,
    replyInProgress: Boolean(payload.reply_in_progress ?? payload.replyInProgress),
    statusLine: (payload.status_line as string | undefined) || (payload.statusLine as string | undefined) || undefined,
    statusDoneLine:
      (payload.status_done_line as string | undefined) || (payload.statusDoneLine as string | undefined) || undefined,
    replyPreview:
      (payload.reply_preview as string | undefined) || (payload.replyPreview as string | undefined) || undefined,
    replyTo: (payload.reply_to as string | undefined) || (payload.replyTo as string | undefined) || undefined,
    backend: (payload.backend as string | undefined) || undefined,
    threadId: (payload.thread_id as string | undefined) || (payload.threadId as string | undefined) || undefined,
    daemon: (payload.daemon as string | undefined) || undefined,
    pid:
      typeof payload.pid === 'number'
        ? payload.pid
        : typeof payload.pid === 'string' && Number.isFinite(Number(payload.pid))
          ? Number(payload.pid)
          : undefined,
    sessionId:
      (payload.session_id as string | undefined) ||
      (payload.sessionId as string | undefined) ||
      (payload.thread_id as string | undefined) ||
      (payload.threadId as string | undefined) ||
      undefined,
    sessionFilePath:
      (payload.session_file_path as string | undefined) || (payload.sessionFilePath as string | undefined) || undefined,
    tokenUsagePercent:
      typeof payload.token_usage_percent === 'number'
        ? payload.token_usage_percent
        : typeof payload.tokenUsagePercent === 'number'
          ? payload.tokenUsagePercent
          : typeof payload.token_usage_percent === 'string' && Number.isFinite(Number(payload.token_usage_percent))
            ? Number(payload.token_usage_percent)
            : typeof payload.tokenUsagePercent === 'string' && Number.isFinite(Number(payload.tokenUsagePercent))
              ? Number(payload.tokenUsagePercent)
              : undefined,
    contextUsagePercent:
      typeof payload.context_usage_percent === 'number'
        ? payload.context_usage_percent
        : typeof payload.contextUsagePercent === 'number'
          ? payload.contextUsagePercent
          : typeof payload.context_usage_percent === 'string' && Number.isFinite(Number(payload.context_usage_percent))
            ? Number(payload.context_usage_percent)
            : typeof payload.contextUsagePercent === 'string' && Number.isFinite(Number(payload.contextUsagePercent))
              ? Number(payload.contextUsagePercent)
              : undefined,
    createdAt: (payload.created_at as string | undefined) || (payload.createdAt as string | undefined) || undefined,
  };
}

export function handleWSMessage(data: { type: string; payload: Record<string, unknown> }) {
  const { type, payload } = data;

  switch (type) {
    case 'task_user_message':
    case 'task_sdk_message': {
      const normalized = normalizeMessagePayload(payload);
      if (!normalized) break;
      useChatStore.getState().addMessage(normalized.taskId, normalized.message);
      const tasksStore = useTasksStore.getState();
      const task = tasksStore.tasks.find((item) => item.id === normalized.taskId);

      if (task) {
        tasksStore.updateTaskInList(
          {
            ...task,
            updatedAt: normalized.message.createdAt ?? task.updatedAt ?? task.createdAt,
            lastUserMessage:
              normalized.message.role === 'user' ? normalized.message.content : task.lastUserMessage ?? null,
            lastAssistantMessage:
              normalized.message.role === 'user' ? task.lastAssistantMessage ?? null : normalized.message.content,
          },
          { moveToFront: true },
        );
      } else {
        void tasksStore.fetchTask(normalized.taskId);
      }

      // Mark as unread if not user message
      if (normalized.message.role !== 'user') {
        tasksStore.markTaskUnread(normalized.taskId);
      }
      break;
    }

    case 'task_status_update': {
      const taskId = normalizeTaskId(payload);
      if (!taskId) break;
      const status = normalizeTaskStatus(payload.status);
      const tasksStore = useTasksStore.getState();
      const task = tasksStore.tasks.find((t) => t.id === taskId);
      if (task) {
        tasksStore.updateTaskInList({ ...task, status });
      } else {
        void tasksStore.fetchTask(taskId);
      }
      if (status === 'completed' || status === 'killed' || status === 'unknown') {
        useRuntimeStore.getState().clearTask(taskId);
      }
      if (task?.taskType === 'pty_task' || useTerminalStore.getState().byTask[taskId]) {
        useTerminalStore.getState().markTaskStatus(taskId, status);
      }
      break;
    }

    case 'task_runtime_status': {
      const runtime = normalizeRuntimeStatus(payload);
      if (!runtime) break;
      useRuntimeStore.getState().setStatus(runtime);
      break;
    }

    case 'task_log_chunk': {
      // Log chunks can be handled if needed
      break;
    }

    case 'terminal_opened': {
      useTerminalStore.getState().markOpened(payload);
      break;
    }

    case 'terminal_output': {
      const taskId =
        typeof payload.task_id === 'string'
          ? payload.task_id
          : typeof payload.taskId === 'string'
            ? payload.taskId
            : null;
      if (taskId) {
        const terminal = useTerminalStore.getState().byTask[taskId];
        if (terminal?.transportState === 'direct') {
          break;
        }
      }
      useTerminalStore.getState().appendOutput(payload);
      break;
    }

    case 'terminal_snapshot': {
      useTerminalStore.getState().applySnapshot(payload);
      break;
    }

    case 'terminal_exit': {
      useTerminalStore.getState().markExit(payload);
      break;
    }

    case 'terminal_error': {
      useTerminalStore.getState().markError(payload);
      break;
    }

    case 'terminal_access_updated': {
      useTerminalStore.getState().updateAccess(payload);
      break;
    }

    case 'pty_transport_session': {
      useTerminalStore.getState().updateTransportSession(payload);
      break;
    }

    case 'pty_transport_status': {
      useTerminalStore.getState().updateTransportSession(payload);
      break;
    }

    case 'pty_transport_signal': {
      useTerminalStore.getState().handleTransportSignal(payload);
      break;
    }

    case 'task_deleted': {
      const taskId = normalizeTaskId(payload);
      if (!taskId) break;
      useTasksStore.getState().removeTask(taskId);
      useChatStore.getState().clearMessages(taskId);
      useRuntimeStore.getState().clearTask(taskId);
      useTerminalStore.getState().clearTask(taskId);
      break;
    }

    default:
      // Unknown message type
      break;
  }
}
