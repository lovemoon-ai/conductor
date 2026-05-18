/**
 * @love-moon/app-sdk/server — Node-only SDK for talking to Conductor.
 *
 * See `connect()` for the entry point.
 *
 * This file is intentionally a thin re-export surface; implementation lives
 * in client.ts and the http/* / ws/* / tasks/* submodules.
 */
export { connect, AppClient } from './client.js';
export type { AppClientOptions, ConnectOptions } from './client.js';

// Re-export types for ergonomic single-import callers.
export type {
  Task,
  TaskStatus,
  CreateTaskInput,
  Project,
  BindProjectInput,
  Message,
  MessageRole,
  Attachment,
  SendMessageInput,
  RuntimeStatus,
  RuntimeState,
  ChatEvent,
  StreamReplyDelta,
} from '../types/index.js';

export { ConductorAppError, isConductorAppError } from '../types/errors.js';
