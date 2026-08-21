import { create } from 'zustand';
import type { Message, SendMessageInput } from '@/shared/types';
import { getApiClient, ApiRequestError } from '@/shared/api/client';
import { getMessageAttachments } from '@/shared/utils/message-attachments';

// A newly created task briefly reports `running` before its fire owner (the
// conductor-fire subprocess) has bound, so the very first user message can hit
// a transient 409 `task_missing_active_fire_owner`. That 409 is raised BEFORE
// anything is persisted, so the send can be safely retried until the fire owner
// connects instead of dropping the user's first message.
const FIRE_OWNER_NOT_READY_CODE = 'task_missing_active_fire_owner';
const SEND_RETRY_WINDOW_MS = 10_000;
const SEND_RETRY_BASE_MS = 500;
const SEND_RETRY_MAX_MS = 1_500;
const uploadedAttachmentCache = new WeakMap<File, Map<string, string>>();

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isFireOwnerNotReadyError = (error: unknown): boolean =>
  error instanceof ApiRequestError &&
  error.status === 409 &&
  error.payload?.code === FIRE_OWNER_NOT_READY_CODE;

interface ChatState {
  messagesByTask: Record<string, Message[]>;
  historyStateByTask: Record<string, { hasMoreBefore: boolean; oldestMessageId: string | null }>;
  hydratedTaskIds: Set<string>;
  loadingTasks: Set<string>;
  error: string | null;

  // Actions
  fetchMessages: (taskId: string, options?: { beforeId?: string; force?: boolean }) => Promise<void>;
  sendMessage: (taskId: string, input: SendMessageInput) => Promise<Message>;
  uploadAttachments: (taskId: string, files: File[]) => Promise<string[]>;
  clearUploadedAttachmentCache: (taskId: string, files: File[]) => void;
  insertMessage: (taskId: string, input: { content: string; targetReplyTo?: string }) => Promise<Message>;
  addMessage: (taskId: string, message: Message) => void;
  updateMessage: (taskId: string, message: Message) => void;
  clearMessages: (taskId: string) => void;
  invalidateHydratedTasks: (taskId?: string) => void;
  clearError: () => void;
}

const normalizeMessage = (message: any): Message => ({
  id: message.id,
  taskId: message.taskId ?? message.task_id,
  role: message.role,
  content: message.content,
  metadata: message.metadata ?? null,
  attachments: message.attachments ?? getMessageAttachments(message.metadata),
  createdAt: message.createdAt ?? message.created_at,
});

const mergeById = (messages: Message[], incoming: Message): Message[] => {
  const index = messages.findIndex((message) => message.id === incoming.id);
  if (index === -1) {
    return [...messages, incoming];
  }

  const next = [...messages];
  next[index] = incoming;
  return next;
};

const mergeMessageArrays = (existing: Message[], incoming: Message[], mode: 'replace' | 'prepend' | 'merge_latest'): Message[] => {
  if (mode === 'replace') {
    const deduped = new Map<string, Message>();
    incoming.forEach((message) => {
      deduped.set(message.id, message);
    });
    return Array.from(deduped.values());
  }

  if (mode === 'merge_latest') {
    const deduped = new Map<string, Message>();
    existing.forEach((message) => {
      deduped.set(message.id, message);
    });
    incoming.forEach((message) => {
      deduped.set(message.id, message);
    });
    return Array.from(deduped.values()).sort((a, b) => {
      const aTime = Date.parse(a.createdAt || '');
      const bTime = Date.parse(b.createdAt || '');
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
        return aTime - bTime;
      }
      return a.id.localeCompare(b.id);
    });
  }

  const deduped = new Map<string, Message>();
  incoming.forEach((message) => {
    deduped.set(message.id, message);
  });
  existing.forEach((message) => {
    if (!deduped.has(message.id)) {
      deduped.set(message.id, message);
    }
  });
  return Array.from(deduped.values());
};

interface MessagesPageResponse {
  messages: any[];
  pagination?: {
    has_more_before?: boolean;
    oldest_message_id?: string | null;
  } | null;
}

const normalizeMessagesResponse = (
  response: MessagesPageResponse | any[],
): {
  messages: Message[];
  hasMoreBefore: boolean;
  oldestMessageId: string | null;
} => {
  if (Array.isArray(response)) {
    const messages = response.map(normalizeMessage);
    return {
      messages,
      hasMoreBefore: false,
      oldestMessageId: messages[0]?.id ?? null,
    };
  }

  const messages = Array.isArray(response?.messages) ? response.messages.map(normalizeMessage) : [];
  return {
    messages,
    hasMoreBefore: Boolean(response?.pagination?.has_more_before),
    oldestMessageId: response?.pagination?.oldest_message_id ?? messages[0]?.id ?? null,
  };
};

export const useChatStore = create<ChatState>()((set, get) => ({
  messagesByTask: {},
  historyStateByTask: {},
  hydratedTaskIds: new Set(),
  loadingTasks: new Set(),
  error: null,

  fetchMessages: async (taskId, options) => {
    const state = get();
    const beforeId = options?.beforeId?.trim() || null;
    const isInitialLoad = !beforeId;
    if (state.loadingTasks.has(taskId) || (isInitialLoad && state.hydratedTaskIds.has(taskId) && !options?.force)) {
      return;
    }

    set((state) => ({
      loadingTasks: new Set([...state.loadingTasks, taskId]),
      error: null,
    }));
    try {
      const api = getApiClient();
      const query = new URLSearchParams({ limit: '50', pagination: '1' });
      if (beforeId) {
        query.set('before_id', beforeId);
      }
      const response = await api.get<MessagesPageResponse | any[]>(`/tasks/${taskId}/messages?${query.toString()}`);
      const normalized = normalizeMessagesResponse(response);
      set((state) => {
        const newLoading = new Set(state.loadingTasks);
        newLoading.delete(taskId);
        const newHydrated = new Set(state.hydratedTaskIds);
        if (isInitialLoad) {
          newHydrated.add(taskId);
        }
        const existing = state.messagesByTask[taskId] || [];
        const mergeMode = isInitialLoad
          ? options?.force && existing.length > 0
            ? 'merge_latest'
            : 'replace'
          : 'prepend';
        const nextMessages = mergeMessageArrays(existing, normalized.messages, mergeMode);
        const oldestMessageId =
          mergeMode === 'merge_latest'
            ? nextMessages[0]?.id ?? normalized.oldestMessageId ?? null
            : normalized.oldestMessageId ?? nextMessages[0]?.id ?? null;
        return {
          messagesByTask: { ...state.messagesByTask, [taskId]: nextMessages },
          historyStateByTask: {
            ...state.historyStateByTask,
            [taskId]: {
              hasMoreBefore:
                mergeMode === 'merge_latest'
                  ? state.historyStateByTask[taskId]?.hasMoreBefore ?? normalized.hasMoreBefore
                  : normalized.hasMoreBefore,
              oldestMessageId,
            },
          },
          hydratedTaskIds: newHydrated,
          loadingTasks: newLoading,
        };
      });
    } catch (error) {
      set((state) => {
        const newLoading = new Set(state.loadingTasks);
        newLoading.delete(taskId);
        return {
          loadingTasks: newLoading,
          error: error instanceof Error ? error.message : 'Failed to fetch messages',
        };
      });
    }
  },

  sendMessage: async (taskId, input) => {
    // Optimistic update with temporary message
    const tempId = `temp-${Date.now()}`;
    const tempMessage: Message = {
      id: tempId,
      taskId,
      role: input.role || 'user',
      content: input.content,
      createdAt: new Date().toISOString(),
    };

    set((state) => ({
      messagesByTask: {
        ...state.messagesByTask,
        [taskId]: [...(state.messagesByTask[taskId] || []), tempMessage],
      },
    }));

    // Idempotency key so an auto-retry that races a late success cannot persist
    // two user messages server-side. Reuse a caller-supplied key when present so
    // one user action maps to exactly one server-side message.
    const clientRequestId =
      input.clientRequestId ??
      (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${tempId}-${Math.random().toString(36).slice(2)}`);
    const requestBody = { ...input, client_request_id: clientRequestId };

    const api = getApiClient();
    const deadline = Date.now() + SEND_RETRY_WINDOW_MS;
    let attempt = 0;

    for (;;) {
      try {
        const message = normalizeMessage(await api.post<Message>(`/tasks/${taskId}/messages`, requestBody));

        // Replace temp message with real one.
        // If websocket already pushed the same real message, merge by id to avoid duplicates.
        set((state) => ({
          messagesByTask: {
            ...state.messagesByTask,
            [taskId]: (() => {
              const existing = state.messagesByTask[taskId] || [];
              const withoutTemp = existing.filter((m) => m.id !== tempId);
              return mergeById(withoutTemp, message);
            })(),
          },
        }));

        return message;
      } catch (error) {
        // Transient startup race: the task is `running` but its fire owner has
        // not bound yet. Nothing was persisted, so keep the optimistic bubble
        // visible and retry (bounded) until the fire connects.
        if (isFireOwnerNotReadyError(error) && Date.now() < deadline) {
          attempt += 1;
          await delay(Math.min(SEND_RETRY_MAX_MS, SEND_RETRY_BASE_MS * attempt));
          continue;
        }

        // Give up: remove temp message and surface the failure to the caller.
        set((state) => ({
          messagesByTask: {
            ...state.messagesByTask,
            [taskId]: state.messagesByTask[taskId]?.filter((m) => m.id !== tempId) || [],
          },
          error: error instanceof Error ? error.message : 'Failed to send message',
        }));
        throw error;
      }
    }
  },

  uploadAttachments: async (taskId, files) => {
    const api = getApiClient();
    const ids: string[] = [];
    for (const file of files) {
      const cached = uploadedAttachmentCache.get(file)?.get(taskId);
      if (cached) {
        ids.push(cached);
        continue;
      }
      const formData = new FormData();
      formData.set('file', file);
      const result = await api.upload<{ attachment: { id: string } }>(
        `/tasks/${taskId}/attachments`,
        formData,
        { timeoutMs: 120_000 },
      );
      ids.push(result.attachment.id);
      const byTask = uploadedAttachmentCache.get(file) ?? new Map<string, string>();
      byTask.set(taskId, result.attachment.id);
      uploadedAttachmentCache.set(file, byTask);
    }
    return ids;
  },

  clearUploadedAttachmentCache: (taskId, files) => {
    for (const file of files) {
      uploadedAttachmentCache.get(file)?.delete(taskId);
    }
  },

  insertMessage: async (taskId, input) => {
    // Optimistic insert mirrors sendMessage, but hits the /insert endpoint which
    // interrupts the running turn so the inserted message is processed next.
    const tempId = `temp-${Date.now()}`;
    // Idempotency key so a stray double-submit (insert is double-click driven)
    // or a transport retry can't create two distinct user messages server-side.
    const clientMessageId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${tempId}-${Math.random().toString(36).slice(2)}`;
    const tempMessage: Message = {
      id: tempId,
      taskId,
      role: 'user',
      content: input.content,
      createdAt: new Date().toISOString(),
    };

    set((state) => ({
      messagesByTask: {
        ...state.messagesByTask,
        [taskId]: [...(state.messagesByTask[taskId] || []), tempMessage],
      },
    }));

    try {
      const api = getApiClient();
      const body: Record<string, unknown> = { content: input.content, client_message_id: clientMessageId };
      if (input.targetReplyTo) {
        body.target_reply_to = input.targetReplyTo;
      }
      const response = await api.post<{ message?: Message } & Message>(`/tasks/${taskId}/insert`, body);
      const message = normalizeMessage(response?.message ?? response);

      set((state) => ({
        messagesByTask: {
          ...state.messagesByTask,
          [taskId]: (() => {
            const existing = state.messagesByTask[taskId] || [];
            const withoutTemp = existing.filter((m) => m.id !== tempId);
            return mergeById(withoutTemp, message);
          })(),
        },
      }));

      return message;
    } catch (error) {
      set((state) => ({
        messagesByTask: {
          ...state.messagesByTask,
          [taskId]: state.messagesByTask[taskId]?.filter((m) => m.id !== tempId) || [],
        },
        error: error instanceof Error ? error.message : 'Failed to insert message',
      }));
      throw error;
    }
  },

  addMessage: (taskId, message) => {
    set((state) => {
      const existing = state.messagesByTask[taskId] || [];
      const updated = mergeById(existing, message);
      const currentHistory = state.historyStateByTask[taskId];
      return {
        messagesByTask: {
          ...state.messagesByTask,
          [taskId]: updated,
        },
        historyStateByTask: currentHistory
          ? {
              ...state.historyStateByTask,
              [taskId]: {
                ...currentHistory,
                oldestMessageId: updated[0]?.id ?? currentHistory.oldestMessageId,
              },
            }
          : state.historyStateByTask,
      };
    });
  },

  updateMessage: (taskId, message) => {
    set((state) => ({
      messagesByTask: {
        ...state.messagesByTask,
        [taskId]: state.messagesByTask[taskId]?.map((m) =>
          m.id === message.id ? message : m
        ) || [message],
      },
    }));
  },

  clearMessages: (taskId) => {
    set((state) => {
      const { [taskId]: _, ...rest } = state.messagesByTask;
      const { [taskId]: __, ...restHistory } = state.historyStateByTask;
      const hydratedTaskIds = new Set(state.hydratedTaskIds);
      hydratedTaskIds.delete(taskId);
      return { messagesByTask: rest, historyStateByTask: restHistory, hydratedTaskIds };
    });
  },

  invalidateHydratedTasks: (taskId) => {
    set((state) => {
      const hydratedTaskIds = new Set(state.hydratedTaskIds);
      if (taskId) {
        hydratedTaskIds.delete(taskId);
      } else {
        hydratedTaskIds.clear();
      }
      return { hydratedTaskIds };
    });
  },

  clearError: () => set({ error: null }),
}));
