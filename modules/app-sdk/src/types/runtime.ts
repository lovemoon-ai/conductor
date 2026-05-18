/**
 * Runtime status pushed by the daemon while a task is in progress.
 * Mirrors `task_runtime_status` envelope on /ws/app.
 */
export interface RuntimeStatus {
  taskId: string;
  /** High-level phase: 'idle' | 'thinking' | 'tool_call' | 'awaiting_user' | 'done'. */
  state: RuntimeState;
  phase?: string | null;
  source?: string | null;
  /** Short status line shown next to the AI avatar ("Reading file X..."). */
  statusLine?: string | null;
  /** Final status line shown when the reply finishes. */
  statusDoneLine?: string | null;
  replyPreview?: string | null;
  replyTo?: string | null;
  replyInProgress?: boolean;
  backend?: string | null;
  threadId?: string | null;
  daemon?: string | null;
  pid?: number | null;
  sessionId?: string | null;
  sessionFilePath?: string | null;
  tokenUsagePercent?: number | null;
  contextUsagePercent?: number | null;
  createdAt?: string | null;
}

export type RuntimeState =
  | 'idle'
  | 'thinking'
  | 'tool_call'
  | 'awaiting_user'
  | 'done'
  | string;
