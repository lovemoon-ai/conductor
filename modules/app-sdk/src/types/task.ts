/**
 * Task: a single AI conversation within a project.
 *
 * Mirrors the shape returned by Conductor's `/api/tasks/[taskId]` REST endpoint
 * (camelCase normalized). All fields are present after a successful read; the
 * `null`-able fields reflect cases where the backend hasn't populated them yet
 * (e.g. a task created via SDK before its daemon picks it up).
 */
export interface Task {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  /** Backend execution engine ("claude_code" / "codex" / etc.) or null when not selected yet. */
  backendType: string | null;
  /** AI session id assigned by the daemon; null until the daemon attaches. */
  sessionId: string | null;
  sessionFilePath: string | null;
  /** ISO 8601 timestamps. Always present after the task is persisted. */
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'finished'
  | 'failed'
  | 'cancelled'
  | string; // open vocabulary; tolerate future backend additions

export interface CreateTaskInput {
  projectId: string;
  title: string;
  /**
   * Optional first user message. When provided, the backend persists it as
   * the task's initial message right after creation.
   * Maps to the backend's `initialContent` field; the SDK renames it for
   * symmetry with `sendMessage(taskId, content)`.
   */
  initialMessage?: string;
  /** Backend type override (claude_code / codex / kimi-cli / etc.). */
  backendType?: string;
  /** Free-form metadata; merged with SDK audit fields server-side. */
  metadata?: Record<string, unknown>;
}
