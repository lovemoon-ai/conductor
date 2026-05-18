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

  /** Optional. Adapters that don't support attachments may omit. */
  uploadAttachment?(
    taskId: string,
    file: File | Blob,
    opts?: { signal?: AbortSignal; filename?: string },
  ): Promise<{ id: string; url: string }>;
}
