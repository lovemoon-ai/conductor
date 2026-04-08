import type { TaskType } from "@/lib/tasks/task-config";
import type { RestartResultMode, RestartStrategy } from "@/lib/tasks/restart";

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
  metadata?: Record<string, unknown> | null;
  daemonHost?: string | null;
  workspacePath?: string | null;
  repoRoot?: string | null;
  worktreeBranch?: string | null;
  lastCommit?: string | null;
  fileCount?: number | null;
  isDefault?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectWithBoundDaemons extends Project {
  boundDaemonNames: string[];
}

// Task Types
export type TaskStatus = 'init' | 'running' | 'killed' | 'unknown' | 'completed';

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

export interface Task {
  id: string;
  projectId?: string | null;
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
  createdAt: string;
  updatedAt?: string | null;
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
  capabilities?: string[];
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
}

export interface UpdateTaskInput {
  title?: string;
  projectId?: string | null;
  taskType?: TaskType;
  status?: TaskStatus;
  launchConfig?: Record<string, unknown> | null;
  backendType?: string | null;
  sessionId?: string | null;
  sessionFilePath?: string | null;
}

export interface RestartTaskInput {
  backendType?: string;
  strategy?: RestartStrategy;
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
  fileCount?: number;
  bindingConfirmed?: boolean;
}

export interface SendMessageInput {
  content: string;
  role?: MessageRole;
  metadata?: Record<string, unknown>;
}
