/**
 * Message: one entry in a task's chat transcript.
 *
 * Roles:
 *  - 'user'      — message sent by the user (or the SDK on their behalf).
 *  - 'sdk'       — message sent by an SDK / CLI / app integration (still
 *                  appears in the chat as a user-side bubble).
 *  - 'assistant' — AI reply.
 *  - 'system'    — system-emitted notice (rare; renders muted).
 *
 * `role` is intentionally open-vocabulary; new backend roles render as
 * a generic bubble.
 */
export interface Message {
  id: string;
  taskId: string;
  role: MessageRole | string;
  content: string;
  metadata: Record<string, unknown> | null;
  attachments: Attachment[];
  createdAt: string;
}

export type MessageRole = 'user' | 'sdk' | 'assistant' | 'system';

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Resolvable URL or relative path the host must turn into a fetchable URL. */
  url: string;
}

export interface SendMessageInput {
  content: string;
  /** Idempotency key. When omitted, the SDK auto-generates a UUID. */
  clientRequestId?: string;
  metadata?: Record<string, unknown>;
  /** Optional attachments to include with this message; must be pre-uploaded. */
  attachmentIds?: string[];
  /** Role override; defaults to 'sdk'. */
  role?: MessageRole;
}
