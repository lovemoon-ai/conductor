import type { Message, SendMessageInput } from './message.js';
import type { ChatEvent } from './events.js';

/**
 * ChatAdapter: the contract between the React widget and *something* that
 * can talk to a Conductor-shaped backend. The widget calls these methods;
 * implementations decide how to translate to HTTP / WS / GraphQL / in-process
 * calls.
 *
 * The default implementation `createRestAdapter` (in `/react`) talks to a
 * BFF that mirrors Conductor's REST shape. Hosts using a custom wire format
 * just implement this interface directly.
 */
export interface ChatAdapter {
  fetchHistory(
    taskId: string,
    opts?: { beforeId?: string; limit?: number; signal?: AbortSignal },
  ): Promise<{
    messages: Message[];
    hasMoreBefore: boolean;
    oldestMessageId: string | null;
  }>;

  subscribe(
    taskId: string,
    handler: (event: ChatEvent) => void,
  ): { unsubscribe(): void };

  sendMessage(taskId: string, input: SendMessageInput): Promise<Message>;

  interrupt(taskId: string, opts: { targetReplyTo: string }): Promise<void>;

  /**
   * Optional. Restart the task's AI session. Adapters that don't support
   * restart may omit it — the widget hides all restart affordances (empty-
   * state button + bubble action) when this method is absent.
   *
   * `restartMode` mirrors Conductor's REST contract (e.g. `'refresh_session'`
   * to refresh the running session in place). When omitted the BFF decides
   * the default.
   */
  restart?(taskId: string, opts?: { restartMode?: string }): Promise<void>;

  /** Optional. Adapters that don't support attachments may omit. */
  uploadAttachment?(
    taskId: string,
    file: File | Blob,
    opts?: { signal?: AbortSignal; filename?: string },
  ): Promise<{ id: string; url: string }>;
}
