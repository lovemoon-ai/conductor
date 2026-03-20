import { create } from 'zustand';
import type { Message, SendMessageInput } from '../types';
import { getApiClient } from '../api/client';
import { getMessageAttachments } from '../message-attachments';

interface ChatState {
  messagesByTask: Record<string, Message[]>;
  loadingTasks: Set<string>;
  error: string | null;

  // Actions
  fetchMessages: (taskId: string) => Promise<void>;
  sendMessage: (taskId: string, input: SendMessageInput) => Promise<Message>;
  addMessage: (taskId: string, message: Message) => void;
  updateMessage: (taskId: string, message: Message) => void;
  clearMessages: (taskId: string) => void;
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

export const useChatStore = create<ChatState>()((set, get) => ({
  messagesByTask: {},
  loadingTasks: new Set(),
  error: null,

  fetchMessages: async (taskId) => {
    set((state) => ({
      loadingTasks: new Set([...state.loadingTasks, taskId]),
      error: null,
    }));
    try {
      const api = getApiClient();
      const messages = await api.get<Message[]>(`/tasks/${taskId}/messages`);
      set((state) => {
        const newLoading = new Set(state.loadingTasks);
        newLoading.delete(taskId);
        return {
          messagesByTask: { ...state.messagesByTask, [taskId]: messages.map(normalizeMessage) },
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

    try {
      const api = getApiClient();
      const message = normalizeMessage(await api.post<Message>(`/tasks/${taskId}/messages`, input));

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
      // Remove temp message on error
      set((state) => ({
        messagesByTask: {
          ...state.messagesByTask,
          [taskId]: state.messagesByTask[taskId]?.filter((m) => m.id !== tempId) || [],
        },
        error: error instanceof Error ? error.message : 'Failed to send message',
      }));
      throw error;
    }
  },

  addMessage: (taskId, message) => {
    set((state) => {
      const existing = state.messagesByTask[taskId] || [];
      const updated = mergeById(existing, message);
      return {
        messagesByTask: {
          ...state.messagesByTask,
          [taskId]: updated,
        },
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
      return { messagesByTask: rest };
    });
  },

  clearError: () => set({ error: null }),
}));
