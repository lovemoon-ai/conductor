import type { TaskType } from "@/lib/tasks/task-config";
import type { IssuePriorityValue, IssueStatusValue } from "@/lib/issues/config";

// Restart types — defined here to break a circular dep with @/lib/tasks/restart.
// @/lib/tasks/restart re-exports these so the runtime values stay in one place.
export type RestartStrategy = "inplace" | "new_task";
export type RestartResultMode =
  | "inplace_restart"
  | "backend_switch_new_task"
  | "successor_new_task";

// User and Authentication Types
export interface AuthUser {
  id: string;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
}

export interface AuthSession {
  jwtToken: string;
  userToken: string;
  user: AuthUser;
}

// Project Types
export interface Project {
  id: string;
  name: string;
  /**
   * User-supplied icon override read from `.conductor/settings.yaml` (top-level
   * `icon:` or nested `project.icon`). Falls through to the default folder
   * icon when null/undefined. Typical values are a single emoji or short text;
   * `http(s)://…` URLs are rendered as an `<img>`.
   */
  icon?: string | null;
  collaborationId?: string | null;
  collaboration?: ProjectCollaboration | null;
  metadata?: Record<string, unknown> | null;
  daemonHost?: string | null;
  workspacePath?: string | null;
  repoRoot?: string | null;
  worktreeBranch?: string | null;
  lastCommit?: string | null;
  lastCommitAt?: string | null;
  /**
   * Normalized git remote URL (lower-case, trailing `.git` stripped). Captured
   * by the daemon on bind/refresh. Used to merge same-name projects across
   * daemons that share the same upstream repo.
   */
  gitRemoteUrl?: string | null;
  fileCount?: number | null;
  sortOrder?: number | null;
  hidden?: boolean;
  /**
   * When true, the project is excluded from auto-grouping in the project list,
   * even if its name + gitRemoteUrl match other projects.
   */
  mergeOptOut?: boolean;
  isDefault?: boolean;
  taskStatusCounts?: Record<string, number>;
  activeScheduledMessageCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * A merged-project group as displayed in the project list. Members are the
 * underlying Project rows (one per daemon). Single-member groups behave the
 * same as the corresponding standalone project.
 */
export interface ProjectGroup {
  /** Stable key derived from members' ids — used as the group's id in UI. */
  key: string;
  name: string;
  members: Project[];
  /** True when members.length > 1 (multi-daemon merged group). */
  isMerged: boolean;
}

export interface CollaborationMember {
  id: string;
  userId: string;
  projectId: string;
  projectName?: string;
  label: string;
  joinedAt?: string;
  // Raw email/phone are intentionally not surfaced - only `label` is.
  user?: {
    id: string;
    label?: string;
  };
  project?: {
    id: string;
    name: string;
  };
}

export interface ProjectCollaboration {
  id: string;
  inviteToken: string;
  inviteUrl?: string;
  memberCount: number;
  maxMembers: number;
  members: CollaborationMember[];
  createdAt?: string;
}

export interface ProjectWithBoundDaemons extends Project {
  boundDaemonNames: string[];
}

// Issue Types
export type IssueStatus = IssueStatusValue;
export type IssuePriority = IssuePriorityValue;

export interface Issue {
  id: string;
  projectId: string;
  /** Project's display name — populated when fetched via merged group views. */
  projectName?: string | null;
  /** Owning daemon's host — populated when fetched via merged group views. */
  daemonHost?: string | null;
  ownerUserId?: string | null;
  creatorUserId?: string | null;
  // Raw email/phone are intentionally not surfaced - only `label` is.
  owner?: {
    id: string;
    label?: string;
  } | null;
  creator?: {
    id: string;
    label?: string;
  } | null;
  title: string;
  description?: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  position: number;
  metadata?: Record<string, unknown> | null;
  /**
   * Last-known AI backend type (e.g. "codex", "claude") for any task linked to
   * this issue. Persisted on the issue itself so the breadcrumb survives task
   * deletion or unlinking.
   */
  aiBackendType?: string | null;
  /**
   * Last-known AI session id for any task linked to this issue. Persisted on
   * the issue itself so the breadcrumb survives task deletion or unlinking.
   */
  aiSessionId?: string | null;
  activeTask?: Task | null;
  linkedTask?: Task | null;
  tasks?: Task[] | null;
  createdAt: string;
  updatedAt?: string | null;
}

// Task Types
export type TaskStatus = 'init' | 'running' | 'killing' | 'killed' | 'unknown' | 'completed';

export interface PtySession {
  id: string;
  taskId: string;
  state: string;
  entrypointType?: string | null;
  toolPreset?: string | null;
  command?: Record<string, unknown> | null;
  cwd?: string | null;
  env?: Record<string, unknown> | null;
  shell?: string | null;
  pid?: number | null;
  cols?: number | null;
  rows?: number | null;
  lastOutputSeq?: number;
  startedAt?: string | null;
  closedAt?: string | null;
  createdAt?: string;
  updatedAt?: string | null;
}

/**
 * Summary of an AttachedTerminal — a PTY task that is bound to an AI task and
 * rendered inside the AI task's detail pane instead of as a standalone card.
 * Only AI tasks ever carry this field; for PTY tasks it is always null.
 *
 * `ptyTaskStatus` is denormalized from the PTY Task row so the AI task card
 * can render the PTY toggle dot (alive vs dead) without a second fetch and
 * without keeping the attached PTY task in the top-level list.
 */
export interface AttachedTerminalSummary {
  id: string;
  ptyTaskId: string;
  ptyTaskStatus: TaskStatus | null;
}

export interface Task {
  id: string;
  projectId?: string | null;
  /**
   * Display-only secondary project. When set (only ever on a task whose real
   * `projectId` is the user's default project), the task is rendered under this
   * project instead of the default one. It never affects the daemon, session,
   * or any behaviour beyond which project bucket the card appears in.
   */
  secondProjectId?: string | null;
  issueId?: string | null;
  title: string;
  taskType?: TaskType;
  status: TaskStatus;
  agentHost?: string | null;
  executionHost?: string | null;
  backendType?: string | null;
  sessionId?: string | null;
  sessionFilePath?: string | null;
  launchConfig?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  lastUserMessage?: string | null;
  lastAssistantMessage?: string | null;
  ptySession?: PtySession | null;
  attachedTerminal?: AttachedTerminalSummary | null;
  activeScheduledMessageCount?: number;
  /** Non-null once the task has been achieved (packed). Achieved tasks are
   * excluded from the active list; their transcript is kept for search. */
  achievedAt?: string | null;
  createdAt: string;
  updatedAt?: string | null;
}

/**
 * A row in the Achieved-task manager: a packed task surfaced for search and
 * retrieval. Carries a matched transcript snippet and its origin project.
 */
export interface AchievedTaskSummary {
  id: string;
  title: string;
  projectId?: string | null;
  projectName?: string | null;
  backendType?: string | null;
  agentHost?: string | null;
  /** Durable daemon association; differs from agentHost for manual-fire tasks. */
  daemonHost?: string | null;
  status: TaskStatus;
  achievedAt: string;
  createdAt: string;
  /** Best matching snippet from the transcript for the current query, if any. */
  snippet?: string | null;
  messageCount?: number;
}

export interface AchievedTasksPage {
  tasks: AchievedTaskSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Message Types
export type MessageRole = 'user' | 'assistant' | 'sdk';

export type MessageAttachmentKind = 'image' | 'video' | 'audio' | 'file';

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: MessageAttachmentKind;
  downloadUrl: string;
  sha256?: string;
  status?: 'uploaded' | 'bound' | 'materialized' | 'failed';
  createdAt?: string;
  expiresAt?: string;
}

export interface Message {
  id: string;
  taskId: string;
  role: MessageRole;
  content: string;
  metadata?: Record<string, unknown> | null;
  attachments?: MessageAttachment[];
  createdAt?: string;
}

// Agent Types
export interface Agent {
  id: string;
  host: string;
  supportedBackends?: string[];
  runtimeBackendMap?: Record<string, string>;
  capabilities?: string[];
  version?: string;
}

// WebSocket Types
export type WSConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface WSMessage {
  type: string;
  payload: Record<string, unknown>;
}

export interface WSTaskMessage {
  type: 'task_user_message' | 'task_sdk_message';
  payload: {
    taskId: string;
    message: Message;
  };
}

export interface WSTaskStatusUpdate {
  type: 'task_status_update';
  payload: {
    taskId: string;
    status: TaskStatus;
  };
}

export interface TaskRuntimeStatus {
  taskId: string;
  state?: string;
  phase?: string;
  source?: string;
  replyInProgress?: boolean;
  statusLine?: string;
  statusDoneLine?: string;
  replyPreview?: string;
  replyTo?: string;
  backend?: string;
  threadId?: string;
  daemon?: string;
  pid?: number;
  sessionId?: string;
  sessionFilePath?: string;
  tokenUsagePercent?: number;
  contextUsagePercent?: number;
  /**
   * The mode of the most recently dispatched turn, as reported by fire on
   * every dispatch. Live runtime field — consumers should prefer this over
   * the task's persisted `metadata.aiMode` when both are available, since the
   * user can flip modes mid-chat by typing `/goal ...` (or by completing the
   * goal back to a normal turn). Undefined until fire has dispatched at
   * least one turn for this task.
   */
  aiMode?: 'goal' | 'turn';
  createdAt?: string;
}

export interface WSTaskRuntimeStatus {
  type: 'task_runtime_status';
  payload: TaskRuntimeStatus;
}

export interface WSTaskLogChunk {
  type: 'task_log_chunk';
  payload: {
    taskId: string;
    chunk: string;
  };
}

// API Response Types
export interface ApiError {
  error: string;
  message?: string;
  /** Stable machine-readable error discriminator (e.g. task_missing_active_fire_owner). */
  code?: string;
  limit_type?: string;
}

// Create/Update DTOs
export interface CreateTaskInput {
  title: string;
  projectId?: string;
  taskType?: TaskType;
  backendType?: string;
  agentHost?: string;
  initialContent?: string;
  sessionId?: string;
  sessionFilePath?: string;
  launchConfig?: Record<string, unknown> | null;
  parentTaskId?: string;
  /**
   * RFC 0033: multi-agent group. The first entry executes the task (worker);
   * additional entries are spawned as sibling reviewer tasks. Each may carry an
   * optional per-agent backend override (reviewers fall back to the worker's).
   */
  agents?: Array<{ name: string; backend?: string | null }>;
}

export interface UpdateTaskInput {
  title?: string;
  projectId?: string | null;
  taskType?: TaskType;
  status?: TaskStatus;
  launchConfig?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  backendType?: string | null;
  sessionId?: string | null;
  sessionFilePath?: string | null;
}

export interface RestartTaskInput {
  backendType?: string;
  strategy?: RestartStrategy;
  restartMode?: "refresh_session";
  /** Explicit daemon override for the new_task path (`agent_host`). */
  agentHost?: string;
}

export interface RestartTaskResponse {
  mode: RestartResultMode;
  sourceTaskId: string;
  task: Task;
}

export interface CleanupTaskWorktreeResponse {
  task: Task;
  cleanedAt: string;
  removedPath?: string | null;
  worktreeBranch?: string | null;
}

export interface CreateProjectInput {
  name: string;
  metadata?: Record<string, unknown>;
  isDefault?: boolean;
  daemonHost?: string;
  workspacePath?: string;
  repoRoot?: string;
  worktreeBranch?: string;
  lastCommit?: string;
  lastCommitAt?: string;
  fileCount?: number;
  bindingConfirmed?: boolean;
}

export interface UpdateProjectInput {
  name?: string;
  metadata?: Record<string, unknown>;
  isDefault?: boolean;
  daemonHost?: string;
  workspacePath?: string;
  repoRoot?: string;
  worktreeBranch?: string;
  lastCommit?: string;
  lastCommitAt?: string;
  fileCount?: number;
  bindingConfirmed?: boolean;
  hidden?: boolean;
  /** Set true to exclude this project from cross-daemon auto-merging. */
  mergeOptOut?: boolean;
  /**
   * Trigger a daemon-side refresh that re-validates the binding and updates
   * snapshot fields including `gitRemoteUrl`. Used to backfill the field for
   * legacy projects created before the cross-daemon merge feature.
   */
  refresh?: boolean;
}

export interface CreateIssueInput {
  projectId: string;
  ownerUserId?: string;
  title: string;
  description?: string | null;
  status?: IssueStatus;
  priority?: IssuePriority;
  position?: number;
  metadata?: Record<string, unknown> | null;
  /**
   * Ask the API to include project/daemon attribution in the create response.
   * Used by merged cross-daemon views so the newly inserted card has the same
   * daemon badge as list-fetched issues.
   */
  includeProject?: boolean;
}

export interface UpdateIssueInput {
  projectId?: string;
  ownerUserId?: string;
  title?: string;
  description?: string | null;
  status?: IssueStatus;
  priority?: IssuePriority;
  position?: number;
  metadata?: Record<string, unknown> | null;
}

export interface SendMessageInput {
  content: string;
  role?: MessageRole;
  metadata?: Record<string, unknown>;
  attachmentIds?: string[];
  /**
   * Idempotency key (RFC 0025 §5.1). When the client auto-retries a transient
   * send failure, the same key lets the server dedupe so a retry that races a
   * late success cannot persist two user messages.
   */
  clientRequestId?: string;
}
