/**
 * Translate Conductor's `/ws/app` envelopes into the SDK's ChatEvent / StreamReplyDelta
 * shapes.
 *
 * Backend envelope inventory (from web/src/lib/channel/task-event-projector.ts
 * and web/src/lib/realtime/agent-gateway.ts):
 *   - task_user_message    → { type: 'message_appended' } (user echo)
 *   - task_sdk_message     → { type: 'message_appended' } (assistant / sdk role)
 *   - task_status_update   → { type: 'task_finished' | 'task_failed' | … }
 *   - task_runtime_status  → { type: 'runtime_status' }
 *   - task_created         → ignored at the chat-event layer (caller already
 *                            has the task object from REST)
 *
 * Unknown / unhandled types map to `null` and are dropped silently.
 */
import type { ChatEvent } from '../../types/events.js';
import type { RuntimeStatus } from '../../types/runtime.js';
import { normalizeMessage } from '../normalize.js';

interface BackendEnvelope {
  type?: string;
  payload?: Record<string, unknown>;
}

export function envelopeToChatEvent(
  raw: unknown,
  filterTaskId?: string,
): ChatEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const envelope = raw as BackendEnvelope;
  const type = envelope.type;
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const taskId = readString(payload.task_id ?? payload.taskId);

  if (filterTaskId && taskId !== filterTaskId) {
    return null;
  }

  switch (type) {
    case 'task_user_message':
    case 'task_sdk_message': {
      const message = normalizeMessage({ ...payload, taskId });
      if (!message.id) return null;
      return { type: 'message_appended', message };
    }

    case 'task_status_update': {
      if (!taskId) return null;
      const status = readString(payload.status);
      if (status === 'finished' || status === 'completed' || status === 'done') {
        return { type: 'task_finished', taskId };
      }
      if (status === 'failed' || status === 'errored') {
        return {
          type: 'task_failed',
          taskId,
          error: {
            code: 'task_failed',
            message: readString(payload.summary) ?? 'Task failed',
          },
        };
      }
      // running / pending / killing etc. — surfaced via runtime_status anyway.
      return null;
    }

    case 'task_runtime_status': {
      if (!taskId) return null;
      const status: RuntimeStatus = {
        taskId,
        state: (readString(payload.state) ?? 'idle') as RuntimeStatus['state'],
        phase: readString(payload.phase),
        source: readString(payload.source),
        statusLine: readString(payload.status_line ?? payload.statusLine),
        statusDoneLine: readString(payload.status_done_line ?? payload.statusDoneLine),
        replyPreview: readString(payload.reply_preview ?? payload.replyPreview),
        replyTo: readString(payload.reply_to ?? payload.replyTo),
        replyInProgress: readBool(payload.reply_in_progress ?? payload.replyInProgress),
        backend: readString(payload.backend),
        threadId: readString(payload.thread_id ?? payload.threadId),
        daemon: readString(payload.daemon),
        pid: readNumber(payload.pid),
        sessionId: readString(payload.session_id ?? payload.sessionId),
        sessionFilePath: readString(payload.session_file_path ?? payload.sessionFilePath),
        tokenUsagePercent: readNumber(payload.token_usage_percent ?? payload.tokenUsagePercent),
        contextUsagePercent: readNumber(payload.context_usage_percent ?? payload.contextUsagePercent),
        createdAt: readString(payload.created_at ?? payload.createdAt),
      };
      return { type: 'runtime_status', status };
    }

    default:
      // Warn only when NODE_ENV is explicitly 'development'. Previously we
      // warned whenever NODE_ENV !== 'production', which also fired during
      // tests (vitest sets NODE_ENV='test') and polluted test output. Narrow
      // the trigger to authors actually running the integration locally.
      if (
        typeof process !== 'undefined' &&
        process.env &&
        process.env.NODE_ENV === 'development'
      ) {
        // eslint-disable-next-line no-console
        console.warn(
          `[app-sdk] envelopeToChatEvent: unknown envelope type "${type ?? ''}" (dropped)`,
        );
      }
      return null;
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function readBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  return undefined;
}
